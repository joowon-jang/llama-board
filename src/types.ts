export type Mode = "server" | "cli";

export interface EnvVar {
  key: string;
  value: string;
}

export interface Profile {
  name: string;
  mode: Mode;
  provider: "openai" | "anthropic";
  anthropic_api_key: string;
  anthropic_version: string;
  max_tokens: number;
  executable: string;
  model_path: string;
  mmproj_path: string;
  backend: string;
  device: string;
  gpu_layers: string;
  context_size: number;
  batch_size: number;
  ubatch_size: number;
  cache_type_k: string;
  cache_type_v: string;
  flash_attn: "auto" | "on" | "off";
  kv_unified: boolean;
  temperature: number;
  top_p: number;
  top_k: number;
  min_p: number;
  presence_penalty: number;
  repeat_penalty: number;
  reasoning: boolean;
  reasoning_effort: string;
  reasoning_preserve: boolean;
  spec_type: string;
  spec_draft_n_max: number;
  spec_draft_n_min: number;
  host: string;
  port: number;
  parallel: number;
  ui: boolean;
  extra_args: string;
  env_overrides: EnvVar[];
}

export interface CommandPreview {
  executable: string;
  args: string[];
  powershell: string;
  cmd: string;
  posix: string;
}

export interface BackendInfo {
  id: string;
  label: string;
  available: boolean;
  status: string;
  devices: string[];
}

export interface EnvironmentSnapshot {
  platform: string;
  runtime_path: string;
  version: string;
  help_available: boolean;
  devices: string[];
  backends: BackendInfo[];
  notes: string[];
}

export interface HelpOption {
  flag: string;
  aliases: string[];
  section: string;
  description: string;
}

export interface LaunchResult {
  pid: number;
  command: CommandPreview;
}

export interface ReleaseInfo {
  tag_name: string;
  name: string;
  html_url: string;
  body?: string;
  published_at?: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}
