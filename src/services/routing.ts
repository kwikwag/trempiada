import { z } from "zod";
import type { GeoPoint, RouteResult, DetourResult } from "../types";
import type { Logger } from "../logger";
import { noopLogger } from "../logger";

const OsrmRouteSchema = z.object({
  distance: z.number(),
  duration: z.number(),
  geometry: z.string().optional(),
});

const OsrmRouteResponseSchema = z.object({
  code: z.string(),
  routes: z.array(OsrmRouteSchema).optional(),
});

const OsrmWaypointSchema = z.object({
  location: z.tuple([z.number(), z.number()]),
});

const OsrmNearestResponseSchema = z.object({
  code: z.string(),
  waypoints: z.array(OsrmWaypointSchema).optional(),
});

/**
 * OSRM client for route calculation and detour estimation.
 *
 * Talks to a self-hosted OSRM instance loaded with Israel OSM data.
 * Setup: download israel-latest.osm.pbf from Geofabrik, then:
 *   osrm-extract -p car.lua israel-latest.osm.pbf
 *   osrm-partition israel-latest.osrm
 *   osrm-customize israel-latest.osrm
 *   osrm-routed --algorithm=MLD israel-latest.osrm
 */
export class RoutingService {
  private baseUrl: string;

  constructor(
    osrmUrl: string = "http://localhost:5000",
    private logger: Logger = noopLogger,
  ) {
    this.baseUrl = osrmUrl.replace(/\/$/, "");
  }

  /**
   * Get a route between two points.
   * Returns distance, duration, and encoded polyline geometry.
   */
  async getRoute(origin: GeoPoint, dest: GeoPoint): Promise<RouteResult | null> {
    const coords = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
    const url = `${this.baseUrl}/route/v1/driving/${coords}?overview=full&geometries=polyline`;
    const start = Date.now();

    try {
      const res = await fetch(url);
      const parsed = OsrmRouteResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        this.logger.warn("osrm_route_response_invalid", {
          durationMs: Date.now() - start,
          err: parsed.error,
        });
        return null;
      }
      const data = parsed.data;

      if (data.code !== "Ok" || !data.routes?.length) {
        this.logger.warn("osrm_route_unavailable", {
          durationMs: Date.now() - start,
          code: data.code,
          routeCount: data.routes?.length ?? 0,
        });
        return null;
      }

      const route = data.routes[0];
      if (!route.geometry) {
        this.logger.warn("osrm_route_missing_geometry", {
          durationMs: Date.now() - start,
          distanceMeters: route.distance,
          durationSeconds: route.duration,
        });
        return null;
      }
      this.logger.debug("osrm_route_completed", {
        durationMs: Date.now() - start,
        distanceMeters: route.distance,
        routeDurationSeconds: route.duration,
      });
      return {
        distanceMeters: route.distance,
        durationSeconds: route.duration,
        geometry: route.geometry,
      };
    } catch (err) {
      this.logger.error("osrm_route_failed", {
        durationMs: Date.now() - start,
        err,
      });
      return null;
    }
  }

  /**
   * Calculate the detour cost of picking up and dropping off a rider
   * along a driver's route.
   *
   * Compares: origin → dest (direct)
   * vs:       origin → pickup → dropoff → dest (with detour)
   *
   * Returns null if the route can't be calculated.
   */
  async calculateDetour(
    driverOrigin: GeoPoint,
    driverDest: GeoPoint,
    pickup: GeoPoint,
    dropoff: GeoPoint,
  ): Promise<DetourResult | null> {
    const start = Date.now();
    // Direct route
    const direct = await this.getRoute(driverOrigin, driverDest);
    if (!direct) {
      this.logger.warn("osrm_detour_direct_route_unavailable", {
        durationMs: Date.now() - start,
      });
      return null;
    }

    // Route with detour: origin → pickup → dropoff → dest
    const coords = [
      `${driverOrigin.lng},${driverOrigin.lat}`,
      `${pickup.lng},${pickup.lat}`,
      `${dropoff.lng},${dropoff.lat}`,
      `${driverDest.lng},${driverDest.lat}`,
    ].join(";");

    const url = `${this.baseUrl}/route/v1/driving/${coords}?overview=false`;

    try {
      const res = await fetch(url);
      const parsed = OsrmRouteResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        this.logger.warn("osrm_detour_response_invalid", {
          durationMs: Date.now() - start,
          err: parsed.error,
        });
        return null;
      }
      const data = parsed.data;

      if (data.code !== "Ok" || !data.routes?.length) {
        this.logger.warn("osrm_detour_unavailable", {
          durationMs: Date.now() - start,
          code: data.code,
          routeCount: data.routes?.length ?? 0,
        });
        return null;
      }

      const detourRoute = data.routes[0];
      this.logger.debug("osrm_detour_completed", {
        durationMs: Date.now() - start,
        originalDurationSeconds: direct.durationSeconds,
        detourDurationSeconds: detourRoute.duration,
        addedSeconds: detourRoute.duration - direct.durationSeconds,
      });
      return {
        originalDuration: direct.durationSeconds,
        detourDuration: detourRoute.duration,
        addedSeconds: detourRoute.duration - direct.durationSeconds,
        pickupPoint: pickup,
        dropoffPoint: dropoff,
      };
    } catch (err) {
      this.logger.error("osrm_detour_failed", {
        durationMs: Date.now() - start,
        err,
      });
      return null;
    }
  }

  /**
   * Find the nearest point on a route to a given location.
   * Uses OSRM's nearest service.
   */
  async findNearest(point: GeoPoint): Promise<GeoPoint | null> {
    const url = `${this.baseUrl}/nearest/v1/driving/${point.lng},${point.lat}`;
    const start = Date.now();

    try {
      const res = await fetch(url);
      const parsed = OsrmNearestResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        this.logger.warn("osrm_nearest_response_invalid", {
          durationMs: Date.now() - start,
          err: parsed.error,
        });
        return null;
      }
      const data = parsed.data;

      if (data.code !== "Ok" || !data.waypoints?.length) {
        this.logger.warn("osrm_nearest_unavailable", {
          durationMs: Date.now() - start,
          code: data.code,
          waypointCount: data.waypoints?.length ?? 0,
        });
        return null;
      }

      const [lng, lat] = data.waypoints[0].location;
      this.logger.debug("osrm_nearest_completed", { durationMs: Date.now() - start });
      return { lat, lng };
    } catch (err) {
      this.logger.error("osrm_nearest_failed", {
        durationMs: Date.now() - start,
        err,
      });
      return null;
    }
  }
}
