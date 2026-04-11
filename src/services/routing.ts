import { z } from "zod";
import type { GeoPoint, RouteResult, DetourResult } from "../types";

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

  constructor(osrmUrl: string = "http://localhost:5000") {
    this.baseUrl = osrmUrl.replace(/\/$/, "");
  }

  /**
   * Get a route between two points.
   * Returns distance, duration, and encoded polyline geometry.
   */
  async getRoute(origin: GeoPoint, dest: GeoPoint): Promise<RouteResult | null> {
    const coords = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
    const url = `${this.baseUrl}/route/v1/driving/${coords}?overview=full&geometries=polyline`;

    try {
      const res = await fetch(url);
      const parsed = OsrmRouteResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        console.warn("OSRM route response validation failed:", parsed.error);
        return null;
      }
      const data = parsed.data;

      if (data.code !== "Ok" || !data.routes?.length) {
        return null;
      }

      const route = data.routes[0];
      if (!route.geometry) {
        return null;
      }
      return {
        distanceMeters: route.distance,
        durationSeconds: route.duration,
        geometry: route.geometry,
      };
    } catch (err) {
      console.error("OSRM route error:", err);
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
    // Direct route
    const direct = await this.getRoute(driverOrigin, driverDest);
    if (!direct) return null;

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
        console.warn("OSRM detour response validation failed:", parsed.error);
        return null;
      }
      const data = parsed.data;

      if (data.code !== "Ok" || !data.routes?.length) {
        return null;
      }

      const detourRoute = data.routes[0];
      return {
        originalDuration: direct.durationSeconds,
        detourDuration: detourRoute.duration,
        addedSeconds: detourRoute.duration - direct.durationSeconds,
        pickupPoint: pickup,
        dropoffPoint: dropoff,
      };
    } catch (err) {
      console.error("OSRM detour error:", err);
      return null;
    }
  }

  /**
   * Find the nearest point on a route to a given location.
   * Uses OSRM's nearest service.
   */
  async findNearest(point: GeoPoint): Promise<GeoPoint | null> {
    const url = `${this.baseUrl}/nearest/v1/driving/${point.lng},${point.lat}`;

    try {
      const res = await fetch(url);
      const parsed = OsrmNearestResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        console.warn("OSRM nearest response validation failed:", parsed.error);
        return null;
      }
      const data = parsed.data;

      if (data.code !== "Ok" || !data.waypoints?.length) {
        return null;
      }

      const [lng, lat] = data.waypoints[0].location;
      return { lat, lng };
    } catch (err) {
      console.error("OSRM nearest error:", err);
      return null;
    }
  }
}
