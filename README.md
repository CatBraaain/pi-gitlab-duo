# pi-gitlab-duo

GitLab Duo provider extension for [pi](https://github.com/badlogic/pi-mono).

Provides access to GitLab Duo AI models (Claude and GPT) through GitLab's AI Gateway.

## Models

| Model ID | Backend |
|----------|---------|
| `duo-chat-opus-4-5` | Claude Opus 4.5 |
| `duo-chat-sonnet-4-5` | Claude Sonnet 4.5 |
| `duo-chat-haiku-4-5` | Claude Haiku 4.5 |
| `duo-chat-gpt-5-1` | GPT-5.1 |
| `duo-chat-gpt-5-mini` | GPT-5 Mini |
| `duo-chat-gpt-5-codex` | GPT-5 Codex |

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
pi --provider gitlab-duo --model duo-chat-sonnet-4-5
```

## Usage

```bash
# Interactive mode
pi --provider gitlab-duo --model duo-chat-sonnet-4-5

# Print mode
pi --provider gitlab-duo --model duo-chat-sonnet-4-5 -p "explain git rebase"
```

## Requirements

- GitLab Duo subscription (Duo Pro or Duo Enterprise)
- pi >= 0.49.0

## License

MIT
