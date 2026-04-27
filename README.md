# sonarqube-api-mcp

Docker-free SonarQube MCP server for read-only access to the SonarQube Web API.

Run it with:

```bash
npx sonarqube-api-mcp
```

## Requirements

- Node.js 20+
- SonarQube token with permission to browse the target project
- No Docker

This package uses the public SonarQube Web API only. It does not use private SonarQube UI GraphQL endpoints.

## Configuration

Configure the server entirely through environment variables in `mcp.json`.

| Variable | Required | Description |
| --- | --- | --- |
| `SONAR_HOST_URL` | Yes | SonarQube base URL. Trailing slashes are normalized. |
| `SONAR_TOKEN` | Yes | SonarQube token. Sent as Basic Auth using `Authorization: Basic base64("${SONAR_TOKEN}:")`. |
| `SONAR_PROJECT_KEY` | No | Default project key used by project-scoped tools when `projectKey` is omitted. |

Startup fails clearly when `SONAR_HOST_URL` or `SONAR_TOKEN` is missing.

## Published package usage

```json
{
  "mcpServers": {
    "sonarqube": {
      "command": "npx",
      "args": ["-y", "sonarqube-api-mcp"],
      "env": {
        "SONAR_HOST_URL": "https://sonarqube.yourcompany.com",
        "SONAR_TOKEN": "YOUR_SONAR_TOKEN",
        "SONAR_PROJECT_KEY": "hvmb-app"
      }
    }
  }
}
```

## Local package development

Build first:

```bash
npm install
npm run build
```

Then point your MCP client at the compiled entrypoint:

```json
{
  "mcpServers": {
    "sonarqube-local": {
      "command": "node",
      "args": ["/absolute/path/to/sonarqube-api-mcp/dist/index.js"],
      "env": {
        "SONAR_HOST_URL": "https://sonarqube.yourcompany.com",
        "SONAR_TOKEN": "YOUR_SONAR_TOKEN",
        "SONAR_PROJECT_KEY": "hvmb-app"
      }
    }
  }
}
```

## Default project key

Set `SONAR_PROJECT_KEY` once and omit `projectKey` from project-scoped tool calls.

```json
{
  "mcpServers": {
    "sonarqube": {
      "command": "npx",
      "args": ["-y", "sonarqube-api-mcp"],
      "env": {
        "SONAR_HOST_URL": "https://sonarqube.yourcompany.com",
        "SONAR_TOKEN": "YOUR_SONAR_TOKEN",
        "SONAR_PROJECT_KEY": "hvmb-app"
      }
    }
  }
}
```

Example tool input:

```json
{
  "resolved": false,
  "severities": ["BLOCKER", "CRITICAL"]
}
```

## Per-tool projectKey override

Every project-scoped tool accepts `projectKey`, which overrides `SONAR_PROJECT_KEY` for that call.

```json
{
  "projectKey": "another-project",
  "branch": "main",
  "metricKeys": ["coverage", "bugs", "vulnerabilities"]
}
```

## Tools

### `search_sonar_issues`

Searches `/api/issues/search` and handles pagination.

Inputs:

- `projectKey` optional, falls back to `SONAR_PROJECT_KEY`
- `branch` optional
- `pullRequest` optional
- `severities` optional string array
- `statuses` optional string array
- `types` optional string array
- `resolved` optional boolean, defaults to `false`
- `pageSize` optional number, defaults to `100`

Returns clean JSON with issue `key`, `rule`, `severity`, `type`, `message`, `component`, `filePath`, `line`, `textRange`, `effort`, `status`, and `tags`.

### `get_quality_gate_status`

Calls `/api/qualitygates/project_status`.

Inputs:

- `projectKey` optional, falls back to `SONAR_PROJECT_KEY`
- `branch` optional
- `pullRequest` optional

### `get_rule_details`

Calls `/api/rules/show`.

Inputs:

- `ruleKey` required

### `get_component_measures`

Calls `/api/measures/component`.

Inputs:

- `projectKey` optional, falls back to `SONAR_PROJECT_KEY`
- `metricKeys` required string array
- `branch` optional
- `pullRequest` optional

### `get_sonar_sources`

Calls `/api/sources/lines`.

Inputs:

- `component` required
- `from` optional number
- `to` optional number
- `branch` optional
- `pullRequest` optional

## Errors

SonarQube API errors are wrapped as JSON strings containing:

- `endpoint`
- `status`
- `message`

HTML error pages are never returned directly.

## Development

```bash
npm install
npm run build
```

`prepublishOnly` runs the build before publishing.
