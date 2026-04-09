# StarUML LLM Diagram Generator

Generate StarUML diagrams from natural-language descriptions using an LLM API.

This extension adds menu commands inside StarUML to:
- configure your LLM endpoint, model, and API key
- generate diagrams from a text prompt

Supported diagram types:
- Class Diagram
- Use Case Diagram
- Sequence Diagram
- ER Diagram
- Flowchart
- Auto Detect

## Features

- Native StarUML extension (JavaScript)
- OpenAI-compatible chat completions API support
- Retry system with exponential backoff for transient API failures
- Friendly error messages for rate limits and provider errors

## Requirements

- StarUML 6.0.0 or newer
- Internet connection for remote LLM APIs
- API key from your provider (for example: OpenAI-compatible or Gemini OpenAI-compatible endpoint)

## Project Structure

- `main.js`: extension logic (commands, API call, diagram generation)
- `menus/llm-diagram-generator.json`: Tools menu entries
- `package.json`: StarUML extension metadata

## Install For End Users

### Linux

User extension directory:

`~/.config/StarUML/extensions/user`

Install:

```bash
mkdir -p ~/.config/StarUML/extensions/user
cp -r /path/to/starumltool ~/.config/StarUML/extensions/user/starumltool
```

### macOS

User extension directory:

`~/Library/Application Support/StarUML/extensions/user`

Install:

```bash
mkdir -p "$HOME/Library/Application Support/StarUML/extensions/user"
cp -R /path/to/starumltool "$HOME/Library/Application Support/StarUML/extensions/user/starumltool"
```

### Windows (PowerShell)

User extension directory:

`$env:APPDATA\StarUML\extensions\user`

Install:

```powershell
New-Item -ItemType Directory -Force -Path "$env:APPDATA\StarUML\extensions\user" | Out-Null
Copy-Item -Recurse -Force "C:\path\to\starumltool" "$env:APPDATA\StarUML\extensions\user\starumltool"
```

After install on any OS:
1. Start StarUML (or reload with Ctrl+R / Cmd+R)
2. Open Tools menu
3. Run Configure LLM Diagram Generator
4. Run Generate Diagram from Description

## Development Setup

### 1. Clone

```bash
git clone https://github.com/<your-user>/starumltool.git
cd starumltool
```

### 2. Link Extension Folder (Recommended)

This lets StarUML read your working copy directly.

#### Linux

```bash
mv ~/.config/StarUML/extensions/user/starumltool ~/.config/StarUML/extensions/user/starumltool.backup 2>/dev/null || true
ln -s "$PWD" ~/.config/StarUML/extensions/user/starumltool
```

#### macOS

```bash
mv "$HOME/Library/Application Support/StarUML/extensions/user/starumltool" "$HOME/Library/Application Support/StarUML/extensions/user/starumltool.backup" 2>/dev/null || true
ln -s "$PWD" "$HOME/Library/Application Support/StarUML/extensions/user/starumltool"
```

#### Windows (PowerShell, run as Administrator if needed)

```powershell
$target = "$env:APPDATA\StarUML\extensions\user\starumltool"
if (Test-Path $target) { Rename-Item $target "$target.backup" -Force }
New-Item -ItemType SymbolicLink -Path $target -Target (Get-Location).Path
```

### 3. Reload StarUML

- Use Debug -> Reload, or restart StarUML.

## Configure API

In StarUML:
1. Tools -> Configure LLM Diagram Generator
2. Set:
   - Endpoint
   - Model
   - API key

Example Gemini OpenAI-compatible endpoint:

`https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`

Example model:

`gemini-2.0-flash`

## Usage

1. Tools -> Generate Diagram from Description
2. Choose diagram type (or Auto Detect)
3. Describe your system in natural language
4. Extension calls the API and generates the diagram

## Troubleshooting

### 429 Too Many Requests

- Quota or rate limit exceeded.
- Wait and retry, or switch model/provider.
- Check provider dashboard for model quota.

### 503 Service Unavailable

- Temporary provider issue.
- Retry after a short delay.
- The extension already retries automatically with backoff.

### 404 Not Found

- Endpoint or model name is wrong.
- Verify endpoint path and model value.

### Extension does not appear in StarUML

- Check folder name and location for your OS.
- Confirm `package.json` exists.
- Reload/restart StarUML.

## Security Notes

- API key is stored in StarUML preferences on your machine.
- Do not commit real API keys to git.

## License

MIT
