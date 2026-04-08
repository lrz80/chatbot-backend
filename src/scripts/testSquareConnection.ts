import { getBookingProviderConnection } from "../lib/appointments/booking/providers/providerConnections.repo";
import { squareRetrieveLocation } from "../lib/appointments/booking/providers/square.client";

async function main() {
  const tenantId = "0f931145-6ec3-4fa4-b20f-978f3f43af23";

  const connection = await getBookingProviderConnection(tenantId, "square");

  if (!connection) {
    console.error("No se encontró conexión Square");
    process.exit(1);
  }

  const accessToken = String(connection.access_token || "").trim();
  const locationId =
    String(connection.external_location_id || "").trim() ||
    String(connection.metadata?.["location_id"] || "").trim();

  const environment =
    String(connection.metadata?.["environment"] || "production").trim().toLowerCase() === "sandbox"
      ? "sandbox"
      : "production";

  const result = await squareRetrieveLocation({
    accessToken,
    environment,
    locationId,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});