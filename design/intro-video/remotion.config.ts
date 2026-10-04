import {Config} from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
Config.setCrf(18);
Config.setColorSpace('bt709'); // tagged limited-range yuv420p, plays the same everywhere
Config.setConcurrency(4);
Config.setOverwriteOutput(true);
