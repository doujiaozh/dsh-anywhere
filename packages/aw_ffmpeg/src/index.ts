/**
 * @anywhere/ffmpeg — zero-native A/V processing, anywhere.
 */

export {
  AwFfmpeg,
  AudioFormat,
  FrameFormat,
  MediaFile,
  MediaProbe,
  parseProbeLog,
  ffmpeg,
} from './api';

export {
  DEFAULT_FFMPEG_CORE_URL,
  FfmpegEngine,
  FfmpegEngineOptions,
  FfmpegEvents,
  ProgressInfo,
} from './engine';

export {
  bootFfmpegCore,
  BootOptions,
  CoreModule,
  CoreSource,
  loadCoreFactory,
} from './core-loader';

export const AW_FFMPEG_VERSION = '0.1.0';
