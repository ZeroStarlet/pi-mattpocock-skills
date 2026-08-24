import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseFrontmatter,
	type ExtensionAPI,
	type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type SkillFrontmatter = {
	name?: unknown;
	description?: unknown;
	"disable-model-invocation"?: unknown;
};

type PackagedSkill = {
	name: string;
	description: string;
};

type SubagentResult = {
	label: string;
	task: string;
	output: string;
	stderr: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
};

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const promotedBuckets = [
	join(packageRoot, "skills", "engineering"),
	join(packageRoot, "skills", "productivity"),
];
const maxParallelSubagents = 4;
const singleOutputCap = 40 * 1024;
const parallelOutputCap = 11 * 1024;

function readPackagedSkills(): PackagedSkill[] {
	const skills: PackagedSkill[] = [];

	for (const bucket of promotedBuckets) {
		if (!existsSync(bucket)) continue;

		for (const entry of readdirSync(bucket, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;

			const filePath = join(bucket, entry.name, "SKILL.md");
			if (!existsSync(filePath)) continue;

			const source = readFileSync(filePath, "utf8");
			const { frontmatter } = parseFrontmatter<SkillFrontmatter>(source);
			const name = typeof frontmatter.name === "string" ? frontmatter.name : entry.name;
			const description =
				typeof frontmatter.description === "string"
					? frontmatter.description
					: `Run the ${name} skill.`;

			skills.push({ name, description });
		}
	}

	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function getSkillCommands(pi: ExtensionAPI): SlashCommandInfo[] {
	return pi.getCommands().filter((command) => command.source === "skill");
}

function loadSkillCommand(command: SlashCommandInfo): {
	body: string;
	disableModelInvocation: boolean;
	filePath: string;
	baseDir: string;
} {
	const filePath = command.sourceInfo.path;
	const source = readFileSync(filePath, "utf8");
	const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(source);

	return {
		body,
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		filePath,
		baseDir: dirname(filePath),
	};
}

function escapeXmlAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function formatSkillInvocation(
	name: string,
	filePath: string,
	baseDir: string,
	body: string,
	args?: string,
): string {
	const skillBlock = [
		`<skill name="${escapeXmlAttribute(name)}" location="${escapeXmlAttribute(filePath)}">`,
		`References are relative to ${baseDir}.`,
		"",
		body.trim(),
		"</skill>",
	].join("\n");

	return args?.trim() ? `${skillBlock}\n\n${args.trim()}` : skillBlock;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function finalAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const candidate = message as {
		role?: unknown;
		content?: Array<{ type?: unknown; text?: unknown }>;
	};
	if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return "";

	return candidate.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= maxBytes) return text;

	const kept = bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
	return `${kept}\n\n[Output truncated. ${bytes.byteLength - Buffer.byteLength(kept, "utf8")} bytes omitted.]`;
}

async function runSubagent(options: {
	label: string;
	task: string;
	cwd: string;
	model?: string;
	thinkingLevel?: string;
	trusted: boolean;
	signal?: AbortSignal;
}): Promise<SubagentResult> {
	const args = [
		"--mode",
		"json",
		"--print",
		"--no-session",
		"--exclude-tools",
		"subagent",
	];

	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	if (options.trusted) args.push("--approve");
	args.push("--", `Task: ${options.task}`);

	const invocation = getPiInvocation(args);

	return new Promise<SubagentResult>((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdoutBuffer = "";
		let stderr = "";
		let output = "";
		let stopReason: string | undefined;
		let errorMessage: string | undefined;
		let aborted = false;

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const event = JSON.parse(line) as {
					type?: unknown;
					message?: {
						stopReason?: unknown;
						errorMessage?: unknown;
					};
				};
				if (event.type === "message_end") {
					const text = finalAssistantText(event.message);
					if (text) output = text;
					if (typeof event.message?.stopReason === "string") {
						stopReason = event.message.stopReason;
					}
					if (typeof event.message?.errorMessage === "string") {
						errorMessage = event.message.errorMessage;
					}
				}
			} catch {
				// Ignore non-JSON output. Pi's JSON mode normally emits JSONL only.
			}
		};

		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			aborted = true;
			child.kill("SIGTERM");
			forceKillTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
				}
			}, 5000);
			forceKillTimer.unref();
		};

		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });

		child.on("error", (error) => {
			options.signal?.removeEventListener("abort", abort);
			reject(error);
		});

		child.on("close", (code) => {
			options.signal?.removeEventListener("abort", abort);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (stdoutBuffer.trim()) processLine(stdoutBuffer);
			if (aborted) {
				reject(new Error(`Subagent ${options.label} was aborted.`));
				return;
			}

			resolve({
				label: options.label,
				task: options.task,
				output,
				stderr: stderr.trim(),
				exitCode: code ?? 1,
				stopReason,
				errorMessage,
			});
		});
	});
}

const ParallelTask = Type.Object({
	label: Type.Optional(Type.String({ description: "Short label for this subagent" })),
	task: Type.String({ description: "Self-contained task for this subagent" }),
});

export default function piCompatibility(pi: ExtensionAPI) {
	const packagedSkills = readPackagedSkills();

	for (const packagedSkill of packagedSkills) {
		pi.registerCommand(packagedSkill.name, {
			description: packagedSkill.description,
			handler: async (args, ctx) => {
				const commandAvailable = getSkillCommands(pi).some(
					(command) => command.name === `skill:${packagedSkill.name}`,
				);
				if (!commandAvailable) {
					ctx.ui.notify(
						`Skill ${packagedSkill.name} is disabled or unavailable. Enable it with pi config.`,
						"warning",
					);
					return;
				}

				const invocation = `/skill:${packagedSkill.name}${args.trim() ? ` ${args.trim()}` : ""}`;
				const options = ctx.isIdle()
					? { expandPromptTemplates: true }
					: { expandPromptTemplates: true, deliverAs: "followUp" as const };
				pi.sendUserMessage(invocation, options);
			},
		});
	}

	pi.registerTool({
		name: "skill",
		label: "Skill",
		description:
			"Load a model-invoked PI skill by name and return its full instructions. Use this when another skill explicitly tells you to call the Skill tool. User-invoked skills cannot be loaded with this tool.",
		promptSnippet: "Load another model-invoked skill by name",
		promptGuidelines: [
			"Use skill when an active skill explicitly tells you to call the Skill tool. Never use skill to invoke a user-invoked skill.",
		],
		parameters: Type.Object({
			skill: Type.String({
				description: "Skill name, without /skill: or a leading slash",
				minLength: 1,
			}),
			args: Type.Optional(Type.String({ description: "Additional instructions for the loaded skill" })),
		}),
		prepareArguments(args) {
			const input =
				args && typeof args === "object"
					? (args as {
							skill?: unknown;
							name?: unknown;
							args?: unknown;
							arguments?: unknown;
						})
					: {};
			const skill =
				typeof input.skill === "string"
					? input.skill
					: typeof input.name === "string"
						? input.name
						: "";
			const additionalArgs = input.args ?? input.arguments;
			return {
				skill,
				args: typeof additionalArgs === "string" ? additionalArgs : undefined,
			};
		},
		async execute(_toolCallId, params) {
			const requestedName = params.skill.replace(/^\/?skill:/, "").replace(/^\//, "");
			const command = getSkillCommands(pi).find(
				(candidate) => candidate.name === `skill:${requestedName}`,
			);

			if (!command) {
				const available = getSkillCommands(pi)
					.map((candidate) => candidate.name.replace(/^skill:/, ""))
					.sort()
					.join(", ");
				throw new Error(
					`Unknown skill "${requestedName}". Available skills: ${available || "none"}.`,
				);
			}

			const loaded = loadSkillCommand(command);
			if (loaded.disableModelInvocation) {
				throw new Error(
					`Skill "${requestedName}" is user-invoked. Tell the user to run /${requestedName} instead.`,
				);
			}

			return {
				content: [
					{
						type: "text",
						text: formatSkillInvocation(
							requestedName,
							loaded.filePath,
							loaded.baseDir,
							loaded.body,
							params.args,
						),
					},
				],
				details: { skill: requestedName, path: loaded.filePath },
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run one isolated PI subagent, or up to four independent PI subagents in parallel. Each child inherits the current model, thinking level, working directory, project context, and installed skills. Child agents cannot spawn more subagents.",
		promptSnippet: "Delegate isolated work to one or more PI subagents",
		promptGuidelines: [
			"Use subagent when a skill asks for a subagent, background agent, isolated review, or parallel independent exploration.",
		],
		parameters: Type.Object({
			task: Type.Optional(Type.String({ description: "Task for one subagent" })),
			tasks: Type.Optional(
				Type.Array(ParallelTask, {
					description: "Independent tasks to run in parallel",
					minItems: 1,
					maxItems: maxParallelSubagents,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
			const hasParallel = Array.isArray(params.tasks) && params.tasks.length > 0;
			if (hasSingle === hasParallel) {
				throw new Error("Provide exactly one of task or tasks.");
			}

			const defaults = {
				cwd: ctx.cwd,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
				trusted: ctx.isProjectTrusted(),
				signal,
			};

			if (hasSingle) {
				onUpdate?.({
					content: [{ type: "text", text: "Subagent running..." }],
					details: { mode: "single" },
				});
				const result = await runSubagent({
					...defaults,
					label: "subagent",
					task: params.task!,
				});
				if (
					result.exitCode !== 0 ||
					result.stopReason === "error" ||
					result.stopReason === "aborted"
				) {
					throw new Error(
						result.errorMessage ||
							result.stderr ||
							result.output ||
							"Subagent failed without output.",
					);
				}
				return {
					content: [
						{
							type: "text",
							text: truncateUtf8(result.output || "(no output)", singleOutputCap),
						},
					],
					details: { mode: "single", results: [result] },
				};
			}

			const tasks = params.tasks!;
			onUpdate?.({
				content: [{ type: "text", text: `Starting ${tasks.length} parallel subagents...` }],
				details: { mode: "parallel", total: tasks.length },
			});

			let completed = 0;
			const results = await Promise.all(
				tasks.map(async (task, index): Promise<SubagentResult> => {
					const label = task.label?.trim() || `subagent-${index + 1}`;
					try {
						return await runSubagent({ ...defaults, label, task: task.task });
					} catch (error) {
						return {
							label,
							task: task.task,
							output: "",
							stderr: error instanceof Error ? error.message : String(error),
							exitCode: 1,
						};
					} finally {
						completed += 1;
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `${completed}/${tasks.length} parallel subagents finished.`,
								},
							],
							details: { mode: "parallel", completed, total: tasks.length },
						});
					}
				}),
			);

			const summaries = results.map((result) => {
				const succeeded =
					result.exitCode === 0 &&
					result.stopReason !== "error" &&
					result.stopReason !== "aborted";
				const output = succeeded
					? result.output || "(no output)"
					: result.errorMessage ||
						result.stderr ||
						result.output ||
						"Subagent failed without output.";
				return `### ${result.label}: ${succeeded ? "completed" : "failed"}\n\n${truncateUtf8(output, parallelOutputCap)}`;
			});

			return {
				content: [
					{
						type: "text",
						text: summaries.join("\n\n---\n\n"),
					},
				],
				details: { mode: "parallel", results },
			};
		},
	});
}
