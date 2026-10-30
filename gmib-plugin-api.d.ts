/** Public authoring types for gmib Plugin API 1.2. */

export const GMIB_PLUGIN_API_VERSION: "1.2.0";

export type PluginPermission =
  | "http.routes"
  | "storage"
  | "realtime"
  | "output.pages"
  | "database"
  | "services.provide"
  | "services.consume"
  | "plugins.read"
  | "output.control"
  | "player.control"
  | "nibus.read"
  | "nibus.write";

export type PluginOutputPage = {
  id: string;
  title: string;
  path: string;
};

export type PluginControlPage = {
  title?: string;
  path: string;
};

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  gmibApi: string;
  main?: string;
  public?: string;
  permissions?: PluginPermission[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  contributes?: { sports: PluginSport[] };
  localOnly?: boolean;
  pages?: PluginOutputPage[];
  control?: PluginControlPage;
};

export type PluginHttpAccess = "local" | "authenticated";
export type PluginHttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export type PluginHttpRequest = {
  method: PluginHttpMethod;
  path: string;
  query: Record<string, string | string[]>;
  body: unknown;
};

export type PluginHttpResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
};

export type PluginHttpHandler = (
  request: PluginHttpRequest,
) => unknown | Promise<unknown>;

export type PluginHttpRouteOptions = {
  access?: PluginHttpAccess;
};

export type PluginHttpRegistrar = (
  route: string,
  handler: PluginHttpHandler,
  options?: PluginHttpRouteOptions,
) => void;

export type PluginLogger = {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export type PluginContext = PluginServicesContext & {
  apiVersion: string;
  plugin: Readonly<PluginManifest>;
  logger: PluginLogger;
  http: {
    delete: PluginHttpRegistrar;
    get: PluginHttpRegistrar;
    patch: PluginHttpRegistrar;
    post: PluginHttpRegistrar;
    put: PluginHttpRegistrar;
    response: (
      status: number,
      body?: unknown,
      headers?: Record<string, string>,
    ) => PluginHttpResponse;
  };
  storage: {
    get: <T = unknown>(key: string, defaultValue?: T) => Promise<T | undefined>;
    set: (key: string, value: unknown) => Promise<void>;
    update: <T = unknown>(
      key: string,
      updater: (value: T | undefined) => T,
    ) => Promise<T>;
  };
  events: {
    publish: (event: string, data?: unknown) => void;
  };
  nibus: PluginNibusApi;
  output: PluginOutputApi & {
    registerPage: (page: PluginOutputPage) => Promise<void>;
  };
};

export type PluginActivate = (context: PluginContext) => void | Promise<void>;

export type PluginModule = {
  activate?: PluginActivate;
  default?: {
    activate?: PluginActivate;
  };
};

/** Shape received by a browser after context.events.publish(name, payload). */
export type PluginEventMessage<T = unknown> = {
  event: `plugin:${string}:${string}`;
  data: [T | null];
};

export type PluginUnsubscribe = () => void;
export type PluginSqlValue = string | number | null | Uint8Array;
export type PluginMigration = { version: number; sql: string };
export type PluginSql = {
  all: <T = Record<string, unknown>>(
    sql: string,
    params?: PluginSqlValue[],
  ) => Promise<T[]>;
  get: <T = Record<string, unknown>>(
    sql: string,
    params?: PluginSqlValue[],
  ) => Promise<T | undefined>;
  run: (
    sql: string,
    params?: PluginSqlValue[],
  ) => Promise<{ changes: number; lastID: number }>;
};
export type PluginDatabase = PluginSql & {
  transaction: <T>(work: (transaction: PluginSql) => Promise<T>) => Promise<T>;
};
export type PluginServicesContext = {
  database: {
    open: (
      name: string,
      migrations: PluginMigration[],
    ) => Promise<PluginDatabase>;
  };
  services: {
    provide: (name: string, version: string, service: object) => void;
    require: <T extends object>(
      pluginId: string,
      name: string,
      range: string,
    ) => T;
  };
  plugins: { listSports: () => PluginSportStatus[] };
  lifecycle: { onDispose: (handler: () => void | Promise<void>) => void };
  clock: {
    now: () => number;
    onSuspend: (handler: () => void) => PluginUnsubscribe;
    onResume: (handler: () => void) => PluginUnsubscribe;
  };
};

export type PluginSport = {
  id: string;
  name: string;
  rosterVersion: number;
  positions: Array<{ id: string; name: string }>;
};

export type PluginSportStatus = PluginSport & {
  pluginId: string;
  installed: boolean;
  enabled: boolean;
  ready: boolean;
  error?: string;
};

export type PluginOutputProfile = {
  screenId: number;
  pageId: string;
  autoStart: boolean;
};
export type PluginOutputApi = {
  /** Plugin API 1.2, requires player.control; never focuses GMIB. */
  listPlayers?: () => Promise<
    Array<{ id: number; name: string; playing: boolean }>
  >;
  setPlayerState?: (state: {
    playerId: number;
    playing: boolean;
  }) => Promise<void>;
  listScreens: () => Promise<
    Array<{ id: number; name: string; width?: number; height?: number }>
  >;
  getStatus: () => Promise<{
    profile?: PluginOutputProfile;
    active: boolean;
    message: string;
  }>;
  start: (profile: PluginOutputProfile) => Promise<void>;
  stop: () => Promise<void>;
};

export type PluginTimerState = {
  valueMs: number;
  running: boolean;
  mode: "game" | "rest" | "timeout";
};
export type PluginScoreboardState = {
  home: number;
  away: number;
  period: number;
};
export type PluginPenaltyState = { number: string; remainingMs: number };
export type PluginPenaltiesState = {
  home: PluginPenaltyState[];
  away: PluginPenaltyState[];
};
export type PluginTeamsState = { home: string; away: string };
export type PluginNibusConnection = { id: string; name: string };
export type PluginInformationReport = {
  connectionId: string;
  source: string;
} & (
  | { kind: "timer"; value: Partial<PluginTimerState> }
  | { kind: "score"; side: "home" | "away"; value: number }
  | { kind: "period"; value: number }
  | { kind: "penalties"; value: PluginPenaltiesState }
  | { kind: "teamName"; side: "home" | "away"; value: string }
);
export type PluginNibusOutput = {
  sendTimer: (state: PluginTimerState) => Promise<void>;
  sendScoreboard: (state: PluginScoreboardState) => Promise<void>;
  sendPenalties: (state: PluginPenaltiesState) => Promise<void>;
  sendTeams: (state: PluginTeamsState) => Promise<void>;
  release: () => Promise<void>;
};
export type PluginNibusApi = {
  listConnections: () => Promise<PluginNibusConnection[]>;
  onConnectionChange: (
    handler: (connections: PluginNibusConnection[]) => void,
  ) => PluginUnsubscribe;
  onInformationReport: (
    filter: {
      connectionId?: string;
      source?: string;
      kinds?: PluginInformationReport["kind"][];
    },
    handler: (report: PluginInformationReport) => void,
  ) => PluginUnsubscribe;
  acquireOutput: (options: {
    connectionId: string;
    target: string;
    profile: "matchpad";
  }) => Promise<PluginNibusOutput>;
};
