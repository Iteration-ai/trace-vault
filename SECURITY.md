# Security

Traces can contain proprietary code, personal information and credentials.
Redaction is best effort, not a guarantee. Use TLS, restrict database and backup
access, keep deployment credentials private, and review capture permissions.

Do not put live traces, passwords, invitation links, tokens or database backups
in public issues. Report suspected vulnerabilities privately through GitHub's
private vulnerability reporting for `Iteration-ai/trace-vault` if enabled. Otherwise
contact a repository maintainer privately through their GitHub profile to agree
on a secure reporting channel before sending sensitive details.

Include the affected version, deployment mode, a minimal synthetic reproduction
and impact. No response-time guarantee or security support window is established.
