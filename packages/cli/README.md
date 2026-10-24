# feedlantern-cli

Command line and MCP server for [FeedLantern](https://github.com/Jaaayden/feedlantern), a self-hosted website-to-RSS builder. It drives an instance through its public API with a personal access token, for scripts and AI agents such as Claude Code.

```bash
feedlantern login --server https://feeds.example.com
feedlantern detect https://example.com/news
feedlantern preview --url https://example.com/news --item article --title h2 --link a
feedlantern feeds list --table
feedlantern mcp
```

Output is JSON by default; errors are written to stderr as `{"error": {"code", "status", "message", "hint"}}` with documented exit codes. Every write supports `--dry-run`; deletions require `--yes`.

The CLI version matches the server version it was released with. Full documentation (in Chinese): [doc/agent.md](https://github.com/Jaaayden/feedlantern/blob/main/doc/agent.md).
