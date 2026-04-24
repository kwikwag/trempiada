import type { Repository } from "../db/repository";
import type { SessionManager } from "./session";
import type { MatchingService } from "../services/matching";
import type { RoutingService } from "../services/routing";
import type { CarRecognitionService } from "../services/car-recognition";
import type { GeocodingService } from "../services/geocoding";
import type { TelegramPhotoService } from "../services/identity/telegram-photo";
import type { ProfileFaceService } from "../services/identity/profile-face";
import type { FaceLivenessService } from "../services/identity/liveness";
import type { Logger } from "../logger";

export interface BotDeps {
  repo: Repository;
  sessions: SessionManager;
  matching: MatchingService;
  routing: RoutingService;
  carRecognition: CarRecognitionService;
  geocoding: GeocodingService;
  telegramPhotos: TelegramPhotoService;
  profileFace: ProfileFaceService;
  faceLiveness: FaceLivenessService;
  notify: (args: NotifyArgs) => Promise<void>;
  logger: Logger;
}

export interface NotifyArgs {
  targetId: number;
  text: string;
  extra?: object;
}
