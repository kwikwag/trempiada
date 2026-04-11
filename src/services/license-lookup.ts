import Database from "better-sqlite3";

export type LicenseLookupResult = {
    licensePlateNo: number;
    make: string;
    model: string;
    color: string;
    year: number | null;
    seats: number;
} | null;

type LicenseRow = {
    license_plate_no: number;
    make: string;
    model: string;
    color: string;
    year: number | null;
    seats: number;
};

export class LicenseLookupService {
    private readonly db: Database.Database;
    private readonly stmt: Database.Statement<[number], LicenseRow>;

    constructor(dbPath: string) {
        this.db = new Database(dbPath, { readonly: true });

        this.stmt = this.db.prepare<[number], LicenseRow>(`
            SELECT
            v.license_plate_no,
            mk.make_name  AS make,
            md.model_name AS model,
            c.color_name  AS color,
            v.year         AS year,
            v.seats
            FROM licenses v
            JOIN make_names  mk ON mk.make_id = v.make_id
            JOIN model_names md ON md.model_id = v.model_id
            JOIN color_names c  ON c.color_id = v.color_id
            WHERE v.license_plate_no = ?
        `);
    }

    getByLicensePlateNumber(licensePlateNo: string | number): LicenseLookupResult {
        const normalized =
            typeof licensePlateNo === "number"
                ? String(licensePlateNo)
                : licensePlateNo.replace(/\D/g, "");

        if (!/^\d{7,8}$/.test(normalized)) {
            throw new Error(
                `Invalid license plate number: ${licensePlateNo}. Expected 7 or 8 digits.`
            );
        }

        const row = this.stmt.get(Number(normalized));
        if (!row) {
            return null;
        }

        return {
            licensePlateNo: row.license_plate_no,
            make: row.make,
            model: row.model,
            color: row.color,
            year: row.year,
            seats: row.seats,
        };
    }

    close(): void {
        this.db.close();
    }
}
