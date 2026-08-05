/** Public authoring types for gmib Plugin API 1.0. */

export const GMIB_PLUGIN_API_VERSION: '1.0.0';

export type PluginPermission = 'http.routes' | 'storage' | 'realtime' | 'output.pages';

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
  pages?: PluginOutputPage[];
  control?: PluginControlPage;
};

export type PluginHttpAccess = 'local' | 'authenticated';
export type PluginHttpMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

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

export type PluginHttpHandler = (request: PluginHttpRequest) => unknown | Promise<unknown>;

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

export type PluginContext = {
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
    update: <T = unknown>(key: string, updater: (value: T | undefined) => T) => Promise<T>;
  };
  events: {
    publish: (event: string, data?: unknown) => void;
  };
  output: {
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
