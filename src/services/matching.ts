import type { Repository } from "../db/repository";
import type { RoutingService } from "./routing";
import type { Ride, RideRequest, GeoPoint, DetourResult } from "../types";
import { POINTS, DEFAULTS } from "../types";
import { haversineKm, generateCode } from "../utils";
import type { Logger } from "../logger";
import { noopLogger } from "../logger";

export interface MatchCandidate {
  request: RideRequest;
  detour: DetourResult;
  /** Quick-reject distance in km (straight line from pickup to route) */
  roughDistanceKm: number;
}

/**
 * Matching service: finds compatible riders for a driver's route
 * and vice versa.
 *
 * The algorithm:
 * 1. Quick filter: Haversine distance from pickup/dropoff to route
 *    endpoints as rough proximity check (eliminates 90%+ of candidates)
 * 2. Time window overlap: does the rider's time window intersect
 *    with the driver's departure?
 * 3. Detour calculation via OSRM: actual added drive time
 * 4. Anti-gaming checks: minimum distance, same-pair cooldown
 * 5. Rank by detour cost (less detour = better match)
 */
export class MatchingService {
  constructor(
    private repo: Repository,
    private routing: RoutingService,
    private logger: Logger = noopLogger,
  ) {}

  /**
   * Find matching ride requests for a newly posted driver ride.
   * Returns candidates sorted by detour cost (ascending).
   */
  async findRidersForDriver(ride: Ride): Promise<MatchCandidate[]> {
    const start = Date.now();
    const openRequests = this.repo.getOpenRequests();
    const candidates: MatchCandidate[] = [];
    const rejected = {
      sameUser: 0,
      timeWindow: 0,
      roughDistance: 0,
      minDistance: 0,
      samePairCooldown: 0,
      noRoute: 0,
      maxDetour: 0,
    };

    const driverOrigin: GeoPoint = { lat: ride.originLat, lng: ride.originLng };
    const driverDest: GeoPoint = { lat: ride.destLat, lng: ride.destLng };
    const departureDate = new Date(ride.departureTime);

    for (const req of openRequests) {
      // Skip if same user
      if (req.riderId === ride.driverId) {
        rejected.sameUser++;
        continue;
      }

      // --- Quick filters ---

      // Time window check
      const earliest = new Date(req.earliestDeparture);
      const latest = new Date(req.latestDeparture);
      if (departureDate < earliest || departureDate > latest) {
        rejected.timeWindow++;
        continue;
      }

      // Rough distance check: pickup should be vaguely near the route
      // Use a generous radius since the actual detour calc is what matters
      const pickupToOrigin = haversineKm(
        req.pickupLat,
        req.pickupLng,
        ride.originLat,
        ride.originLng,
      );
      const pickupToDest = haversineKm(req.pickupLat, req.pickupLng, ride.destLat, ride.destLng);
      const routeLength = haversineKm(ride.originLat, ride.originLng, ride.destLat, ride.destLng);

      // If pickup is farther from both endpoints than the route length,
      // it's almost certainly not along the way
      if (pickupToOrigin > routeLength && pickupToDest > routeLength) {
        rejected.roughDistance++;
        continue;
      }

      // Minimum ride distance (anti-gaming)
      const rideDistance = haversineKm(
        req.pickupLat,
        req.pickupLng,
        req.dropoffLat,
        req.dropoffLng,
      );
      if (rideDistance < POINTS.MIN_RIDE_DISTANCE_KM) {
        rejected.minDistance++;
        continue;
      }

      // Same-pair cooldown (anti-gaming)
      const recentCount = this.repo.getRecentSamePairCount(
        ride.driverId,
        req.riderId,
        POINTS.SAME_PAIR_COOLDOWN_HOURS,
      );
      if (recentCount > 0) {
        rejected.samePairCooldown++;
        continue;
      }

      // --- Actual detour calculation ---
      const pickup: GeoPoint = { lat: req.pickupLat, lng: req.pickupLng };
      const dropoff: GeoPoint = { lat: req.dropoffLat, lng: req.dropoffLng };

      const detour = await this.routing.calculateDetour(driverOrigin, driverDest, pickup, dropoff);

      if (!detour) {
        rejected.noRoute++;
        continue;
      }

      // Check detour against driver's tolerance
      const maxDetourSeconds = ride.maxDetourMinutes * 60;
      if (detour.addedSeconds > maxDetourSeconds) {
        rejected.maxDetour++;
        continue;
      }

      candidates.push({
        request: req,
        detour,
        roughDistanceKm: Math.min(pickupToOrigin, pickupToDest),
      });
    }

    // Sort by detour cost ascending (least inconvenience first)
    candidates.sort((a, b) => a.detour.addedSeconds - b.detour.addedSeconds);

    this.logger.info("matching_riders_for_driver_completed", {
      durationMs: Date.now() - start,
      rideId: ride.id,
      driverId: ride.driverId,
      openRequests: openRequests.length,
      candidateCount: candidates.length,
      rejected,
    });

    return candidates;
  }

  /**
   * Find matching driver rides for a newly posted ride request.
   * Same logic, reversed perspective.
   */
  async findDriversForRider(request: RideRequest): Promise<{ ride: Ride; detour: DetourResult }[]> {
    const start = Date.now();
    const openRides = this.repo.getOpenRides();
    const results: { ride: Ride; detour: DetourResult }[] = [];
    const rejected = {
      sameUser: 0,
      noSeats: 0,
      timeWindow: 0,
      roughDistance: 0,
      minDistance: 0,
      samePairCooldown: 0,
      noRoute: 0,
      maxDetour: 0,
    };

    const earliest = new Date(request.earliestDeparture);
    const latest = new Date(request.latestDeparture);
    const pickup: GeoPoint = { lat: request.pickupLat, lng: request.pickupLng };
    const dropoff: GeoPoint = { lat: request.dropoffLat, lng: request.dropoffLng };

    for (const ride of openRides) {
      if (ride.driverId === request.riderId) {
        rejected.sameUser++;
        continue;
      }
      if (ride.availableSeats < 1) {
        rejected.noSeats++;
        continue;
      }

      const departureDate = new Date(ride.departureTime);
      if (departureDate < earliest || departureDate > latest) {
        rejected.timeWindow++;
        continue;
      }

      // Rough proximity check
      const routeLength = haversineKm(ride.originLat, ride.originLng, ride.destLat, ride.destLng);
      const pickupToOrigin = haversineKm(
        request.pickupLat,
        request.pickupLng,
        ride.originLat,
        ride.originLng,
      );
      if (pickupToOrigin > routeLength) {
        rejected.roughDistance++;
        continue;
      }

      // Min distance
      const rideDistance = haversineKm(
        request.pickupLat,
        request.pickupLng,
        request.dropoffLat,
        request.dropoffLng,
      );
      if (rideDistance < POINTS.MIN_RIDE_DISTANCE_KM) {
        rejected.minDistance++;
        continue;
      }

      // Same-pair cooldown
      const recentCount = this.repo.getRecentSamePairCount(
        ride.driverId,
        request.riderId,
        POINTS.SAME_PAIR_COOLDOWN_HOURS,
      );
      if (recentCount > 0) {
        rejected.samePairCooldown++;
        continue;
      }

      const driverOrigin: GeoPoint = { lat: ride.originLat, lng: ride.originLng };
      const driverDest: GeoPoint = { lat: ride.destLat, lng: ride.destLng };

      const detour = await this.routing.calculateDetour(driverOrigin, driverDest, pickup, dropoff);
      if (!detour) {
        rejected.noRoute++;
        continue;
      }

      const maxDetourSeconds = ride.maxDetourMinutes * 60;
      if (detour.addedSeconds > maxDetourSeconds) {
        rejected.maxDetour++;
        continue;
      }

      results.push({ ride, detour });
    }

    results.sort((a, b) => a.detour.addedSeconds - b.detour.addedSeconds);
    this.logger.info("matching_drivers_for_rider_completed", {
      durationMs: Date.now() - start,
      requestId: request.id,
      riderId: request.riderId,
      openRides: openRides.length,
      candidateCount: results.length,
      rejected,
    });
    return results;
  }

  /**
   * Create a match between a ride and a request.
   * Generates confirmation code and updates statuses.
   */
  createMatch(ride: Ride, request: RideRequest, detour: DetourResult) {
    const code = generateCode(DEFAULTS.CONFIRMATION_CODE_LENGTH);

    const match = this.repo.createMatch({
      rideId: ride.id,
      requestId: request.id,
      riderId: request.riderId,
      driverId: ride.driverId,
      pickupLat: detour.pickupPoint.lat,
      pickupLng: detour.pickupPoint.lng,
      dropoffLat: detour.dropoffPoint.lat,
      dropoffLng: detour.dropoffPoint.lng,
      detourSeconds: detour.addedSeconds,
      confirmationCode: code,
      pointsCost: 0, // Rides are free; points are earned, not spent
    });

    // Update statuses
    this.repo.updateRideStatus(ride.id, "matched");
    this.repo.updateRequestStatus(request.id, "matched");

    this.logger.info("match_created", {
      matchId: match.id,
      rideId: ride.id,
      requestId: request.id,
      driverId: ride.driverId,
      riderId: request.riderId,
      detourSeconds: detour.addedSeconds,
    });

    return match;
  }
}
