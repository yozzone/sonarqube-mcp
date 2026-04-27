#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type QueryValue = string | number | boolean | string[] | undefined;

type SonarIssue = {
  key?: string;
  rule?: string;
  severity?: string;
  type?: string;
  message?: string;
  component?: string;
  line?: number;
  textRange?: unknown;
  effort?: string;
  status?: string;
  tags?: string[];
};

type SonarIssuesResponse = {
  issues?: SonarIssue[];
  total?: number;
  paging?: {
    pageIndex?: number;
    pageSize?: number;
    total?: number;
  };
};

type ApiErrorPayload = {
  errors?: Array<{ msg?: string }>;
  message?: string;
};

const envSchema = z.object({
  SONAR_HOST_URL: z
    .string({ required_error: "SONAR_HOST_URL is required" })
    .trim()
    .min(1, "SONAR_HOST_URL is required"),
  SONAR_TOKEN: z
    .string({ required_error: "SONAR_TOKEN is required" })
    .trim()
    .min(1, "SONAR_TOKEN is required"),
  SONAR_PROJECT_KEY: z.string().trim().optional()
});

const env = parseEnv();
const authHeader = `Basic ${Buffer.from(`${env.SONAR_TOKEN}:`).toString("base64")}`;

const optionalProjectInput = {
  projectKey: z.string().optional(),
  branch: z.string().optional(),
  pullRequest: z.string().optional()
};

const server = new McpServer({
  name: "sonarqube-mcp",
  version: "0.1.0"
});

server.registerTool(
  "search_sonar_issues",
  {
    title: "Search SonarQube issues",
    description: "Search read-only SonarQube issues through /api/issues/search.",
    inputSchema: {
      ...optionalProjectInput,
      severities: z.array(z.string()).optional(),
      statuses: z.array(z.string()).optional(),
      types: z.array(z.string()).optional(),
      resolved: z.boolean().default(false),
      pageSize: z.number().int().positive().max(500).default(100)
    }
  },
  async (input) => {
    return handleTool(async () => {
    const projectKey = getProjectKey(input.projectKey);
    const pageSize = input.pageSize ?? 100;
    const issues: ReturnType<typeof normalizeIssue>[] = [];
    let page = 1;
    let total = 0;

    do {
      const response = await sonarGet<SonarIssuesResponse>("/api/issues/search", {
        componentKeys: projectKey,
        branch: input.branch,
        pullRequest: input.pullRequest,
        severities: input.severities,
        statuses: input.statuses,
        types: input.types,
        resolved: input.resolved ?? false,
        ps: pageSize,
        p: page
      });

      const pageIssues = response.issues ?? [];
      issues.push(...pageIssues.map(normalizeIssue));
      total = response.paging?.total ?? response.total ?? issues.length;
      page += 1;
    } while (issues.length < total);

    return {
      projectKey,
      total,
      returned: issues.length,
      issues
    };
    });
  }
);

server.registerTool(
  "get_quality_gate_status",
  {
    title: "Get quality gate status",
    description: "Get read-only SonarQube quality gate status for a project.",
    inputSchema: optionalProjectInput
  },
  async (input) => {
    return handleTool(async () => {
    const projectKey = getProjectKey(input.projectKey);
    const data = await sonarGet("/api/qualitygates/project_status", {
      projectKey,
      branch: input.branch,
      pullRequest: input.pullRequest
    });

    return data;
    });
  }
);

server.registerTool(
  "get_rule_details",
  {
    title: "Get rule details",
    description: "Get read-only SonarQube rule details.",
    inputSchema: {
      ruleKey: z.string().min(1)
    }
  },
  async (input) => {
    return handleTool(async () => {
    const data = await sonarGet("/api/rules/show", {
      key: input.ruleKey
    });

    return data;
    });
  }
);

server.registerTool(
  "get_component_measures",
  {
    title: "Get component measures",
    description: "Get read-only SonarQube component measures for metric keys.",
    inputSchema: {
      ...optionalProjectInput,
      metricKeys: z.array(z.string().min(1)).min(1)
    }
  },
  async (input) => {
    return handleTool(async () => {
    const projectKey = getProjectKey(input.projectKey);
    const data = await sonarGet("/api/measures/component", {
      component: projectKey,
      metricKeys: input.metricKeys,
      branch: input.branch,
      pullRequest: input.pullRequest
    });

    return data;
    });
  }
);

server.registerTool(
  "get_sonar_sources",
  {
    title: "Get source lines",
    description: "Get read-only SonarQube source lines for a component.",
    inputSchema: {
      component: z.string().min(1),
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
      branch: z.string().optional(),
      pullRequest: z.string().optional()
    }
  },
  async (input) => {
    return handleTool(async () => {
    const data = await sonarGet("/api/sources/lines", {
      key: input.component,
      from: input.from,
      to: input.to,
      branch: input.branch,
      pullRequest: input.pullRequest
    });

    return data;
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

function parseEnv() {
  const parsed = envSchema.safeParse({
    SONAR_HOST_URL: process.env.SONAR_HOST_URL,
    SONAR_TOKEN: process.env.SONAR_TOKEN,
    SONAR_PROJECT_KEY: process.env.SONAR_PROJECT_KEY
  });

  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => issue.message).join("; ");
    console.error(`sonarqube-mcp startup validation failed: ${message}`);
    process.exit(1);
  }

  return {
    ...parsed.data,
    SONAR_HOST_URL: parsed.data.SONAR_HOST_URL.replace(/\/+$/, "")
  };
}

function getProjectKey(projectKey?: string) {
  const resolved = projectKey ?? env.SONAR_PROJECT_KEY;

  if (!resolved) {
    throw new Error("projectKey is required when SONAR_PROJECT_KEY is not set");
  }

  return resolved;
}

async function sonarGet<T = unknown>(endpoint: string, query: Record<string, QueryValue>): Promise<T> {
  const url = new URL(`${env.SONAR_HOST_URL}${endpoint}`);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length > 0) {
        url.searchParams.set(key, value.join(","));
      }
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: authHeader,
      Accept: "application/json"
    }
  });

  const contentType = response.headers.get("content-type") ?? "";
  const bodyText = await response.text();
  const payload = parseJson(bodyText);

  if (!response.ok) {
    throw new Error(JSON.stringify(formatApiError(endpoint, response.status, contentType, payload, bodyText)));
  }

  if (!payload) {
    throw new Error(JSON.stringify(formatApiError(endpoint, response.status, contentType, payload, bodyText)));
  }

  return payload as T;
}

function parseJson(bodyText: string): unknown {
  if (!bodyText.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return undefined;
  }
}

function formatApiError(
  endpoint: string,
  status: number,
  contentType: string,
  payload: unknown,
  bodyText: string
) {
  const apiPayload = payload as ApiErrorPayload | undefined;
  const apiMessage = apiPayload?.errors?.map((error) => error.msg).filter(Boolean).join("; ");
  const message =
    apiMessage ||
    apiPayload?.message ||
    (contentType.includes("text/html") ? "SonarQube returned an HTML error page" : bodyText.slice(0, 500)) ||
    "Unknown SonarQube API error";

  return {
    endpoint,
    status,
    message
  };
}

function normalizeIssue(issue: SonarIssue) {
  return {
    key: issue.key,
    rule: issue.rule,
    severity: issue.severity,
    type: issue.type,
    message: issue.message,
    component: issue.component,
    filePath: getFilePath(issue.component),
    line: issue.line,
    textRange: issue.textRange,
    effort: issue.effort,
    status: issue.status,
    tags: issue.tags ?? []
  };
}

function getFilePath(component?: string) {
  if (!component) {
    return undefined;
  }

  const separatorIndex = component.indexOf(":");
  return separatorIndex === -1 ? component : component.slice(separatorIndex + 1);
}

async function handleTool(read: () => Promise<unknown>) {
  try {
    return jsonContent(await read());
  } catch (error) {
    return {
      isError: true,
      ...jsonContent(toErrorPayload(error))
    };
  }
}

function toErrorPayload(error: unknown) {
  if (error instanceof Error) {
    const parsed = parseJson(error.message);

    if (parsed) {
      return parsed;
    }

    return {
      message: error.message
    };
  }

  return {
    message: String(error)
  };
}

function jsonContent(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}
