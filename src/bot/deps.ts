import type { Repository } from "../db/repository";
import type { SessionManager } from "./session";
import type { MatchingService } from "../services/matching";
import type { RoutingService } from "../services/routing";
import type { CarRecognitionService } from "../services/car-recognition";
import type { GeocodingService } from "../services/geocoding";
import type { Logger } from "../logger";

export interface BotDeps {
  repo: Repository;
  sessions: SessionManager;
  matching: MatchingService;
  routing: RoutingService;
  carRecognition: CarRecognitionService;
  geocoding: GeocodingService;
  notify: (targetId: number, text: string, extra?: object) => Promise<void>;
  logger: Logger;
}
