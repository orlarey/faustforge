**FAUSTFORGE**

With Stephane we are happy to announce FAUSTFORGE: a Docker-first web UI + MCP server for fast Faust prototyping, with an innovative Orbit UI and tight AI-in-the-loop iteration.

Faustforge lets you work in two modes:

1. **Standalone (web app)**
- Drop a `.dsp` file (or paste Faust code directly)
- Browse generated views (`dsp`, `svg`, `run`, `cpp`, `tasks`, `signals`)
- Play and tune in `run` view with:
  - classic Faust UI controls
  - **Orbit UI** for expressive multi-parameter exploration
  - virtual MIDI keyboard (mouse + computer keys)

1. **Coupled with Claude Desktop (MCP)**
- Claude can submit/edit DSP, switch views, run transport, set params, trigger buttons, send MIDI notes, and capture spectrum summaries.
- The key idea: better structured feedback (spectrum + quality metrics) so AI can iterate autonomously with minimal prompting.

### Quick install (test in 1 command)

```bash
docker run -d \
  --name faustforge \
  -p 3000:3000 \
  -v "$HOME/.faustforge/sessions:/app/sessions" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e SESSIONS_DIR=/app/sessions \
  -e HOST_SESSIONS_DIR="$HOME/.faustforge/sessions" \
  -e FAUST_HTTP_URL=http://localhost:3000 \
  ghcr.io/orlarey/faustforge:latest
```

Then open: `http://localhost:3000`

### Claude Desktop MCP config

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "faustforge": {
      "command": "docker",
      "args": ["exec", "-i", "faustforge", "node", "/app/mcp.mjs"]
    }
  }
}
```

Restart Claude Desktop, and you’re ready.

### Credits

- FAUSTFORGE was developed with Codex 5.3, which proved very effective for this type of iterative software development.
- Orbit UI is inspired by the Interactors software developed at GRAME in the 1980s, notably with Thierry Carron and Herve Lequay.
