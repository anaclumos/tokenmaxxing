# Read old file versions with git show, never checkout

Hook correction 2026-07-18: used `git checkout <ref> -- <file>` (then checkout HEAD to restore) just to READ another branch's version of a file. That command form is banned by the safeguards: it overwrites the working copy and would wipe any concurrent uncommitted edit in a shared checkout, even when the intent is read-only.

- To read a file at a ref: `git show <ref>:<path>`.
- To diff a file across refs: `git diff <refA>..<refB> -- <path>`.
- Neither touches the working tree; there is never a read-only reason for `git checkout -- `.
