export interface AiConfig {
  api_key: string;
  base_url?: string;
  model_name: string;
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

export type ImageModelProvider = 'volcengine' | 'google-ai-studio';

export interface ImageModelConfig {
  provider: ImageModelProvider;
  base_url?: string;
  api_key: string;
  model_name: string;
}

export type FileParserProvider = 'local' | 'mineru-accurate-api' | 'mineru-agent-api';

export interface FileParserConfig {
  provider: FileParserProvider;
  mineru_token?: string;
}

export interface ClientConfig extends AiConfig {
  image_model: ImageModelConfig;
  file_parser: FileParserConfig;
  developer_mode?: boolean;
}
