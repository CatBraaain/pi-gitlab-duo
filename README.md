# pi-gitlab-duo

Use GitLab Duo's Claude and GPT models in [Pi](https://github.com/earendil-works/pi) through the GitLab AI Gateway.

## Install

In a checkout of this branch, run `bun install`. Add the checkout's absolute path to `~/.pi/agent/settings.json`, keeping any existing entries:

```json
{
  "packages": ["/path/to/pi-gitlab-duo"]
}
```

This extension requires Pi 1.5.2 or later and an account with Duo access on GitLab.com.

## Log in

1. Start Pi and run `/login gitlab-duo`. If the login picker opens, choose **GitLab Duo**.
2. Authorize the application in your browser.
3. Copy the full callback URL from the address bar and paste it into Pi.
4. Run `/model` to choose a GitLab Duo model.

Existing GitLab Duo OAuth logins still work. You do not need a personal access token. If you already use `GITLAB_TOKEN`, it remains supported as an alternative.

## Models and refresh

Pi checks for new models after login and when you open the model selector. The extension looks up available Duo Chat models with your GitLab credentials and matches them to the AI Gateway's public proxy definitions. New models appear without an extension update when both sources list them and they use a supported proxy.

The last successful list is cached for the current login. A fresh cache avoids requests for 15 minutes unless Pi forces a refresh. On a refresh error, Pi keeps the last successful list, or the original built-in fallback models if discovery has never succeeded for this login. Opening `/model` after the cache expires checks again.

`pi --list-models gitlab-duo` uses saved models or the fallback; it does not wait for a network refresh. To use just-discovered models from the CLI, refresh in an interactive session first.

```sh
pi --provider gitlab-duo --model <model-id>
```

## Limitations

- GitLab.com and the Anthropic Messages and OpenAI Responses proxy routes are supported. Models without a matching route are not listed.
- The Gateway can reject a listed model because of your Duo billing namespace, credits, or a difference between the deployed Gateway and its public definitions.
- If GitLab does not publish input or reasoning capabilities for a new model, the extension uses text-only input and does not enable reasoning by default. Unavailable prices are not estimated.

## License

MIT
