import type { Repository } from "../db/repository";
import type { RoutingService } from "./routing";
import type { Ride, RideRequest, GeoPoint, DetourResult } from "../types";
import { POINTS, DEFAULTS } from "../types";
import { haversineKm, generateCode } from "../utils";

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
  ) {}

  /**
   * Find matching ride requests for a newly posted driver ride.
   * Returns candidates sorted by detour cost (ascending).
   */
  async findRidersForDriver(ride: Ride): Promise<MatchCandidate[]> {
    const openRequests = this.repo.getOpenRequests();
    const candidates: MatchCandidate[] = [];

    const driverOrigin: GeoPoint = { lat: ride.originLat, lng: ride.originLng };
    const driverDest: GeoPoint = { lat: ride.destLat, lng: ride.destLng };
    const departureDate = new Date(ride.departureTime);

    for (const req of openRequests) {
      // Skip if same user
      if (req.riderId === ride.driverId) continue;

      // --- Quick filters ---

      // Time window check
      const earliest = new Date(req.earliestDeparture);
      const latest = new Date(req.latestDeparture);
      if (departureDate < earliest || departureDate > latest) continue;

      // Rough distance check: pickup should be vaguely near the route
      // Use a generous radius since the actual detour calc is what matters
      const pickupToOrigin = haversineKm(
        req.pickupLat, req.pickupLng,
        ride.originLat, ride.originLng
      );
      const pickupToDest = haversineKm(
        req.pickupLat, req.pickupLng,
        ride.destLat, ride.destLng
      );
      const routeLength = haversineKm(
        ride.originLat, ride.originLng,
        ride.destLat, ride.destLng
      );

      // If pickup is farther from both endpoints than the route length,
      // it's almost certainly not along the way
      if (pickupToOrigin > routeLength && pickupToDest > routeLength) continue;

      // Minimum ride distance (anti-gaming)
      const rideDistance = haversineKm(
        req.pickupLat, req.pickupLng,
        req.dropoffLat, req.dropoffLng
      );
      if (rideDistance < POINTS.MIN_RIDE_DISTANCE_KM) continue;

      // Same-pair cooldown (anti-gaming)
      const recentCount = this.repo.getRecentSamePairCount(
        ride.driverId, req.riderId,
        POINTS.SAME_PAIR_COOLDOWN_HOURS
      );
      if (recentCount > 0) continue;

      // --- Actual detour calculation ---
      const pickup: GeoPoint = { lat: req.pickupLat, lng: req.pickupLng };
      const dropoff: GeoPoint = { lat: req.dropoffLat, lng: req.dropoffLng };

      const detour = await this.routing.calculateDetour(
        driverOrigin, driverDest, pickup, dropoff
      );

      if (!detour) continue;

      // Check detour against driver's tolerance
      const maxDetourSeconds = ride.maxDetourMinutes * 60;
      if (detour.addedSeconds > maxDetourSeconds) continue;

      candidates.push({
        request: req,
        detour,
        roughDistanceKm: Math.min(pickupToOrigin, pickupToDest),
      });
    }

    // Sort by detour cost ascending (least inconvenience first)
    candidates.sort((a, b) => a.detour.addedSeconds - b.detour.addedSeconds);

    return candidates;
  }

  /**
   * Find matching driver rides for a newly posted ride request.
   * Same logic, reversed perspective.
   */
  async findDriversForRider(request: RideRequest): Promise<{ride: Ride; detour: DetourResult}[]> {
    const openRides = this.repo.getOpenRides();
    const results: {ride: Ride; detour: DetourResult}[] = [];

    const earliest = new Date(request.earliestDeparture);
    const latest = new Date(request.latestDeparture);
    const pickup: GeoPoint = { lat: request.pickupLat, lng: request.pickupLng };
    const dropoff: GeoPoint = { lat: request.dropoffLat, lng: request.dropoffLng };

    for (const ride of openRides) {
      if (ride.driverId === request.riderId) continue;
      if (ride.availableSeats < 1) continue;

      const departureDate = new Date(ride.departureTime);
      if (departureDate < earliest || departureDate > latest) continue;

      // Rough proximity check
      const routeLength = haversineKm(
        ride.originLat, ride.originLng, ride.destLat, ride.destLng
      );
      const pickupToOrigin = haversineKm(
        request.pickupLat, request.pickupLng,
        ride.originLat, ride.originLng
      );
      if (pickupToOrigin > routeLength) continue;

      // Min distance
      const rideDistance = haversineKm(
        request.pickupLat, request.pickupLng,
        request.dropoffLat, request.dropoffLng
      );
      if (rideDistance < POINTS.MIN_RIDE_DISTANCE_KM) continue;

      // Same-pair cooldown
      const recentCount = this.repo.getRecentSamePairCount(
        ride.driverId, request.riderId,
        POINTS.SAME_PAIR_COOLDOWN_HOURS
      );
      if (recentCount > 0) continue;

      const driverOrigin: GeoPoint = { lat: ride.originLat, lng: ride.originLng };
      const driverDest: GeoPoint = { lat: ride.destLat, lng: ride.destLng };

      const detour = await this.routing.calculateDetour(
        driverOrigin, driverDest, pickup, dropoff
      );
      if (!detour) continue;

      const maxDetourSeconds = ride.maxDetourMinutes * 60;
      if (detour.addedSeconds > maxDetourSeconds) continue;

      results.push({ ride, detour });
    }

    results.sort((a, b) => a.detour.addedSeconds - b.detour.addedSeconds);
    return results;
  }

  /**
   * Create a match between a ride and a request.
   * Generates confirmation code and updates statuses.
   */
  createMatch(
    ride: Ride,
    request: RideRequest,
    detour: DetourResult,
  ) {
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

    return match;
  }
}
