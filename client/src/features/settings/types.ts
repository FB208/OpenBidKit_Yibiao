import type { FileParserConfig, ImageModelConfig } from '../../shared/types';

export interface SettingsPageState {
  textModel: {
    api_key: string;
    base_url: string;
    model_name: string;
  };
  imageModel: ImageModelConfig;
  fileParser: FileParserConfig;
  general: {
    developer_mode: boolean;
  };
}
