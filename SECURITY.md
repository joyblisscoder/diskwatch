# Security and privacy

DiskWatch is intended for a single user's Mac. The HTTP server listens only on
127.0.0.1 and validates the Host header. Don't expose it through a public proxy
or tunnel. It has no remote account or authentication layer.

The local state directory stores folder paths and measurements. It is created
with user-only permissions. Reports and screenshots may also reveal folder names.
Use synthetic paths when reporting bugs and don't upload the state directory.

If you find a vulnerability, use the repository's private vulnerability reporting
option when available. If it isn't available, open an issue asking for a private
contact without including exploit details or personal data.
