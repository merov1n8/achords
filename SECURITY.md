# Security Policy

Please report vulnerabilities privately via GitHub Security Advisories
("Report a vulnerability" on the repository's Security tab). Do not open public issues for security problems.

Design principles: secrets are stored encrypted and are write-only in every UI and API,
agents are deny-by-default, sensitive data is routed to local models only (fail-closed),
and installs accept no inbound vendor access.
