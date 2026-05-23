import type { FileParserConfig, ImageModelConfig, TextModelConfig, TextModelProfiles, TextModelProvider } from '../../shared/types';

export interface SettingsPageState {
  textModel: TextModelConfig & {
    provider: TextModelProvider;
  };
  textModelProfiles: TextModelProfiles;
  imageModel: ImageModelConfig;
  fileParser: FileParserConfig;
  general: {
    developer_mode: boolean;
    real_time_render: boolean;
  };
}
