#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type QueryValue = string | number | boolean | string[] | undefined;

type ProjectSelector = {
  projectKey?: string;
  projectName?: string;
};

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
  issueStatus?: string;
  tags?: string[];
  creationDate?: string;
  updateDate?: string;
  cleanCodeAttribute?: string;
  impacts?: unknown[];
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

type SonarProject = {
  key: string;
  name: string;
  qualifier?: string;
  visibility?: string;
  lastAnalysisDate?: string;
  revision?: string;
};

type SonarProjectsResponse = {
  components?: SonarProject[];
  projects?: SonarProject[];
  paging?: {
    pageIndex?: number;
    pageSize?: number;
    total?: number;
  };
};

type SourceLine = {
  line?: number;
  code?: string;
  scmAuthor?: string;
  scmDate?: string;
  coveredConditions?: number;
  conditions?: number;
  hits?: number;
  duplicated?: boolean;
  isNew?: boolean;
};

type SourcesResponse = {
  sources?: SourceLine[];
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
  projectName: z.string().optional(),
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
      impactSeverities: z.array(z.string()).optional(),
      impactSoftwareQualities: z.array(z.string()).optional(),
      inNewCodePeriod: z.boolean().optional(),
      resolved: z.boolean().default(false),
      pageSize: z.number().int().positive().max(500).default(100)
    }
  },
  async (input) => {
    return handleTool(async () => {
    const project = await resolveProject(input);
    const pageSize = input.pageSize ?? 100;
    const issues: ReturnType<typeof normalizeIssue>[] = [];
    let page = 1;
    let total = 0;

    do {
      const response = await sonarGet<SonarIssuesResponse>("/api/issues/search", {
        componentKeys: project.key,
        branch: input.branch,
        pullRequest: input.pullRequest,
        severities: input.severities,
        statuses: input.statuses,
        types: input.types,
        impactSeverities: input.impactSeverities,
        impactSoftwareQualities: input.impactSoftwareQualities,
        inNewCodePeriod: input.inNewCodePeriod,
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
      project,
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
    const project = await resolveProject(input);
    const data = await sonarGet("/api/qualitygates/project_status", {
      projectKey: project.key,
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
    const project = await resolveProject(input);
    const data = await sonarGet("/api/measures/component", {
      component: project.key,
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

server.registerTool(
  "search_sonar_projects",
  {
    title: "Search SonarQube projects",
    description: "Find SonarQube project keys by project name or key.",
    inputSchema: {
      query: z.string().optional(),
      pageSize: z.number().int().positive().max(500).default(100)
    }
  },
  async (input) => {
    return handleTool(async () => {
      const pageSize = input.pageSize ?? 100;
      const response = await sonarGet<SonarProjectsResponse>("/api/projects/search", {
        q: input.query,
        ps: pageSize,
        p: 1
      });
      const projects = normalizeProjects(response);

      return {
        total: response.paging?.total ?? projects.length,
        returned: projects.length,
        projects
      };
    });
  }
);

server.registerTool(
  "get_sonar_issue_context",
  {
    title: "Get issue context",
    description: "Get one SonarQube issue with source lines around the affected range.",
    inputSchema: {
      issueKey: z.string().min(1),
      branch: z.string().optional(),
      pullRequest: z.string().optional(),
      contextLines: z.number().int().min(0).max(50).default(5),
      includeRule: z.boolean().default(true)
    }
  },
  async (input) => {
    return handleTool(async () => getIssueContext(input.issueKey, input));
  }
);

server.registerTool(
  "get_sonar_fix_plan",
  {
    title: "Get SonarQube fix plan",
    description:
      "Return unresolved SonarQube issues grouped by file with optional source context for fixing new-code or overall-code issues.",
    inputSchema: {
      ...optionalProjectInput,
      scope: z.enum(["new_code", "overall"]).default("new_code"),
      severities: z.array(z.string()).optional(),
      statuses: z.array(z.string()).optional(),
      types: z.array(z.string()).optional(),
      impactSeverities: z.array(z.string()).optional(),
      impactSoftwareQualities: z.array(z.string()).optional(),
      pageSize: z.number().int().positive().max(500).default(100),
      maxIssues: z.number().int().positive().max(1000).default(200),
      includeSource: z.boolean().default(true),
      includeRules: z.boolean().default(false),
      contextLines: z.number().int().min(0).max(50).default(5)
    }
  },
  async (input) => {
    return handleTool(async () => {
      const project = await resolveProject(input);
      const issues = await searchIssues({
        projectKey: project.key,
        branch: input.branch,
        pullRequest: input.pullRequest,
        severities: input.severities,
        statuses: input.statuses,
        types: input.types,
        impactSeverities: input.impactSeverities,
        impactSoftwareQualities: input.impactSoftwareQualities,
        inNewCodePeriod: input.scope === "new_code" ? true : undefined,
        resolved: false,
        pageSize: input.pageSize ?? 100,
        maxIssues: input.maxIssues ?? 200
      });
      const normalizedIssues = issues.map(normalizeIssue);
      const ruleDetails = input.includeRules ? await getRuleDetailsByKey(normalizedIssues) : {};
      const files = await groupIssuesByFile(normalizedIssues, {
        branch: input.branch,
        pullRequest: input.pullRequest,
        includeSource: input.includeSource ?? true,
        contextLines: input.contextLines ?? 5
      });

      return {
        project,
        scope: input.scope ?? "new_code",
        issueCount: normalizedIssues.length,
        truncated: issues.length >= (input.maxIssues ?? 200),
        rules: ruleDetails,
        files
      };
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

async function resolveProject(selector: ProjectSelector) {
  if (selector.projectKey) {
    return {
      key: selector.projectKey
    };
  }

  if (selector.projectName) {
    const matches = await findProjects(selector.projectName);
    const exactMatches = matches.filter(
      (project) => project.name === selector.projectName || project.key === selector.projectName
    );
    const selected = exactMatches.length === 1 ? exactMatches[0] : matches.length === 1 ? matches[0] : undefined;

    if (selected) {
      return selected;
    }

    throw new Error(
      JSON.stringify({
        message:
          matches.length === 0
            ? `No SonarQube project found for projectName '${selector.projectName}'`
            : `Multiple SonarQube projects matched projectName '${selector.projectName}'. Provide projectKey.`,
        candidates: matches.slice(0, 20)
      })
    );
  }

  const resolved = env.SONAR_PROJECT_KEY;

  if (!resolved) {
    throw new Error("projectKey or projectName is required when SONAR_PROJECT_KEY is not set");
  }

  return {
    key: resolved
  };
}

async function findProjects(query: string) {
  const response = await sonarGet<SonarProjectsResponse>("/api/projects/search", {
    q: query,
    ps: 100,
    p: 1
  });

  return normalizeProjects(response);
}

function normalizeProjects(response: SonarProjectsResponse) {
  return (response.projects ?? response.components ?? []).map((project) => ({
    key: project.key,
    name: project.name,
    qualifier: project.qualifier,
    visibility: project.visibility,
    lastAnalysisDate: project.lastAnalysisDate,
    revision: project.revision
  }));
}

async function searchIssues(options: {
  projectKey: string;
  branch?: string;
  pullRequest?: string;
  severities?: string[];
  statuses?: string[];
  types?: string[];
  impactSeverities?: string[];
  impactSoftwareQualities?: string[];
  inNewCodePeriod?: boolean;
  resolved?: boolean;
  pageSize: number;
  maxIssues?: number;
}) {
  const issues: SonarIssue[] = [];
  const maxIssues = options.maxIssues ?? Number.POSITIVE_INFINITY;
  let page = 1;
  let total = 0;

  do {
    const response = await sonarGet<SonarIssuesResponse>("/api/issues/search", {
      componentKeys: options.projectKey,
      branch: options.branch,
      pullRequest: options.pullRequest,
      severities: options.severities,
      statuses: options.statuses,
      types: options.types,
      impactSeverities: options.impactSeverities,
      impactSoftwareQualities: options.impactSoftwareQualities,
      inNewCodePeriod: options.inNewCodePeriod,
      resolved: options.resolved ?? false,
      ps: options.pageSize,
      p: page
    });

    issues.push(...(response.issues ?? []).slice(0, maxIssues - issues.length));
    total = response.paging?.total ?? response.total ?? issues.length;
    page += 1;
  } while (issues.length < total && issues.length < maxIssues);

  return issues;
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
    issueStatus: issue.issueStatus,
    tags: issue.tags ?? [],
    creationDate: issue.creationDate,
    updateDate: issue.updateDate,
    cleanCodeAttribute: issue.cleanCodeAttribute,
    impacts: issue.impacts
  };
}

function getFilePath(component?: string) {
  if (!component) {
    return undefined;
  }

  const separatorIndex = component.indexOf(":");
  return separatorIndex === -1 ? component : component.slice(separatorIndex + 1);
}

async function getIssueContext(
  issueKey: string,
  options: {
    branch?: string;
    pullRequest?: string;
    contextLines?: number;
    includeRule?: boolean;
  }
) {
  const response = await sonarGet<SonarIssuesResponse>("/api/issues/search", {
    issues: issueKey,
    branch: options.branch,
    pullRequest: options.pullRequest,
    ps: 1,
    p: 1
  });
  const issue = response.issues?.[0];

  if (!issue) {
    throw new Error(`No SonarQube issue found for issueKey '${issueKey}'`);
  }

  const normalized = normalizeIssue(issue);
  const source = await getSourceForIssue(normalized, options);
  const rule = options.includeRule === false || !normalized.rule ? undefined : await sonarGet("/api/rules/show", {
    key: normalized.rule
  });

  return {
    issue: normalized,
    source,
    rule
  };
}

async function getSourceForIssue(
  issue: ReturnType<typeof normalizeIssue>,
  options: {
    branch?: string;
    pullRequest?: string;
    contextLines?: number;
  }
) {
  if (!issue.component || !issue.line) {
    return undefined;
  }

  const contextLines = options.contextLines ?? 5;
  const from = Math.max(1, issue.line - contextLines);
  const to = issue.line + contextLines;

  const response = await sonarGet<SourcesResponse>("/api/sources/lines", {
    key: issue.component,
    from,
    to,
    branch: options.branch,
    pullRequest: options.pullRequest
  });

  return {
    component: issue.component,
    filePath: issue.filePath,
    from,
    to,
    lines: response.sources ?? []
  };
}

async function getRuleDetailsByKey(issues: ReturnType<typeof normalizeIssue>[]) {
  const ruleKeys = [...new Set(issues.map((issue) => issue.rule).filter((rule): rule is string => Boolean(rule)))];
  const entries = await Promise.all(
    ruleKeys.map(async (ruleKey) => {
      try {
        return [ruleKey, await sonarGet("/api/rules/show", { key: ruleKey })] as const;
      } catch (error) {
        return [ruleKey, toErrorPayload(error)] as const;
      }
    })
  );

  return Object.fromEntries(entries);
}

async function groupIssuesByFile(
  issues: ReturnType<typeof normalizeIssue>[],
  options: {
    branch?: string;
    pullRequest?: string;
    includeSource: boolean;
    contextLines: number;
  }
) {
  const byComponent = new Map<string, ReturnType<typeof normalizeIssue>[]>();

  for (const issue of issues) {
    const key = issue.component ?? "unknown";
    const group = byComponent.get(key) ?? [];
    group.push(issue);
    byComponent.set(key, group);
  }

  const files = [];

  for (const [component, fileIssues] of byComponent.entries()) {
    const sortedIssues = fileIssues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    const sourceRanges = options.includeSource
      ? await getMergedSourceRanges(component, sortedIssues, options)
      : undefined;

    files.push({
      component,
      filePath: getFilePath(component),
      issueCount: sortedIssues.length,
      issues: sortedIssues,
      sourceRanges
    });
  }

  return files.sort((a, b) => b.issueCount - a.issueCount || (a.filePath ?? "").localeCompare(b.filePath ?? ""));
}

async function getMergedSourceRanges(
  component: string,
  issues: ReturnType<typeof normalizeIssue>[],
  options: {
    branch?: string;
    pullRequest?: string;
    contextLines: number;
  }
) {
  const ranges = mergeRanges(
    issues
      .filter((issue) => issue.line)
      .map((issue) => ({
        from: Math.max(1, (issue.line ?? 1) - options.contextLines),
        to: (issue.line ?? 1) + options.contextLines
      }))
  );

  return Promise.all(
    ranges.map(async (range) => {
      const response = await sonarGet<SourcesResponse>("/api/sources/lines", {
        key: component,
        from: range.from,
        to: range.to,
        branch: options.branch,
        pullRequest: options.pullRequest
      });

      return {
        ...range,
        lines: response.sources ?? []
      };
    })
  );
}

function mergeRanges(ranges: Array<{ from: number; to: number }>) {
  const sorted = ranges.sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [];

  for (const range of sorted) {
    const last = merged.at(-1);

    if (!last || range.from > last.to + 1) {
      merged.push({ ...range });
      continue;
    }

    last.to = Math.max(last.to, range.to);
  }

  return merged;
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
