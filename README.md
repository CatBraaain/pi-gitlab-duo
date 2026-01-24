# pi-gitlab-duo

GitLab Duo provider extension for [pi](https://github.com/badlogic/pi-mono).

Provides access to GitLab Duo AI models (Claude and GPT) through GitLab's AI Gateway.

## Models

| Model ID | Name |
|----------|------|
| `claude-opus-4-5-20251101` | Claude Opus 4.5 |
| `claude-sonnet-4-5-20250929` | Claude Sonnet 4.5 |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 |
| `gpt-5.1-2025-11-13` | GPT-5.1 |
| `gpt-5-mini-2025-08-07` | GPT-5 Mini |
| `gpt-5-codex` | GPT-5 Codex |

All models support extended thinking/reasoning.

## Installation

```bash
pi install npm:pi-gitlab-duo
```

## Authentication

### OAuth (Recommended)

```bash
pi
/login gitlab-duo
```

This will open GitLab's OAuth flow. After authorizing, copy the callback URL and paste it when prompted.

### Personal Access Token

Set the `GITLAB_TOKEN` environment variable:

```bash
export GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
pi --provider gitlab-duo --model claude-sonnet-4-5-20250929
```

## Usage

```bash
# Interactive mode
pi --provider gitlab-duo --model claude-sonnet-4-5-20250929

# With thinking enabled
pi --provider gitlab-duo --model claude-sonnet-4-5-20250929 --thinking medium

# Print mode
pi --provider gitlab-duo --model claude-sonnet-4-5-20250929 -p "explain git rebase"
```

## Requirements

- GitLab Duo subscription (Duo Pro or Duo Enterprise)
- pi >= 0.49.0

## License

MIT
