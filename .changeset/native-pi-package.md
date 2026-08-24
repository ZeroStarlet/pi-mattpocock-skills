---
"mattpocock-skills": patch
---

Ship the promoted skill set as a native PI package. PI users can install the repository with:

```bash
pi install git:github.com/ZeroStarlet/pi-mattpocock-skills
```

Updates arrive through PI's package updater:

```bash
pi update --extensions
```

The package keeps the existing `/skill-name` commands through PI aliases and adds compatibility tools for cross-skill `Skill` calls and isolated or parallel subagents. Beta, miscellaneous, and deprecated skills stay outside the managed package. The repository does not self-register through project PI settings, avoiding duplicate tools when PI runs from a checkout after the git package is installed globally.
