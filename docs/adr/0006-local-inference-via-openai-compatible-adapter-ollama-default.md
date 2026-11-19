# ADR-0006: Local inference via OpenAI-compatible adapter, Ollama default

Status: Accepted (2026-11-19)

- Context: Apple positions MLX as the primary LLM framework on Apple Silicon; Ollama made MLX its default engine there in 2026. Replacing Ollama is not a small job.
- Decision: Ollama default, `mlx-lm` server optional, both behind one adapter.
- Consequences: External dependency, but swappable; no code coupling.
