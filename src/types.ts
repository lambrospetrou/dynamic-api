export type AppVersion = {
  version: number;
  prompt: string;
  code: string;
  created_at: string;
};

export type AppRecord = {
  id: string;
  slug: string;
  description: string;
  created_at: string;
  current: AppVersion;
};

export type AppCtx = {
  appId: string;
  workspace: string;
};

export type RegistryAppRecord = {
  id: string;
  slug: string;
  description: string;
  current_version: number;
  last_updated: string;
  created_at: string;
};
