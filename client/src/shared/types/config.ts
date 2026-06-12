export type TextModelProvider = 'jinlong' | 'volcengine' | 'deepseek' | 'longcat' | 'custom';
export type AiRequestMode = 'normal' | 'stream';
export type UpdateChannel = 'github' | 'cloudflare';

export interface TextModelConfig {
  api_key: string;
  base_url: string;
  model_name: string;
  request_mode: AiRequestMode;
}

export type TextModelProfiles = Record<TextModelProvider, TextModelConfig>;

export interface AiConfig extends TextModelConfig {
  text_model_provider: TextModelProvider;
  text_model_profiles: TextModelProfiles;
}

export interface ConfigSaveResult {
  success: boolean;
  message: string;
  config_path?: string;
}

export interface ModelListResult {
  success: boolean;
  message: string;
  models: string[];
}

export interface ImageModelTestResult {
  success: boolean;
  message: string;
  image_url?: string;
  image_data?: string;
  mime_type?: string;
}

export type ImageModelProvider = 'jinlong' | 'volcengine' | 'google-ai-studio' | 'custom';
export type ImageModelStatus = 'untested' | 'available' | 'unavailable';

export interface ImageModelConfig {
  provider: ImageModelProvider;
  base_url?: string;
  api_key: string;
  model_name: string;
  request_mode: AiRequestMode;
  status?: ImageModelStatus;
  tested_at?: string;
  last_error?: string;
}

export type ImageModelProfiles = Record<ImageModelProvider, ImageModelConfig>;

export type FileParserProvider = 'local' | 'mineru-accurate-api' | 'mineru-agent-api';

export interface FileParserConfig {
  provider: FileParserProvider;
  mineru_token?: string;
}

export interface ClientConfig extends AiConfig {
  image_model: ImageModelConfig;
  image_model_profiles: ImageModelProfiles;
  file_parser: FileParserConfig;
  update_channel?: UpdateChannel;
  gpu_hardware_acceleration_enabled?: boolean;
  gpu_hardware_acceleration_configured?: boolean;
  export_format?: import('./exportFormat').ExportFormatConfig;
  developer_mode?: boolean;
  analytics_client_id?: string;
  analytics_created_at?: string;
}
