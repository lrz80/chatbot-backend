BEGIN;

CREATE TABLE IF NOT EXISTS field_operation_resources (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,

  name TEXT NOT NULL,
  resource_type TEXT NOT NULL,

  external_provider TEXT NULL,
  external_reference TEXT NULL,

  active BOOLEAN NOT NULL DEFAULT TRUE,

  start_address TEXT NULL,
  start_latitude DOUBLE PRECISION NULL,
  start_longitude DOUBLE PRECISION NULL,

  end_address TEXT NULL,
  end_latitude DOUBLE PRECISION NULL,
  end_longitude DOUBLE PRECISION NULL,

  timezone TEXT NULL,
  availability JSONB NOT NULL DEFAULT '{}'::jsonb,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS field_operation_resources_external_reference_uq
  ON field_operation_resources (
    tenant_id,
    external_provider,
    external_reference
  )
  WHERE external_provider IS NOT NULL
    AND external_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS field_operation_resources_tenant_active_idx
  ON field_operation_resources (
    tenant_id,
    active
  );

CREATE TABLE IF NOT EXISTS appointment_locations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,

  location_type TEXT NOT NULL DEFAULT 'service',

  formatted_address TEXT NOT NULL,
  address_components JSONB NOT NULL DEFAULT '{}'::jsonb,

  latitude DOUBLE PRECISION NULL,
  longitude DOUBLE PRECISION NULL,

  geocoding_provider TEXT NULL,
  provider_place_id TEXT NULL,
  geocoding_status TEXT NOT NULL DEFAULT 'pending',
  geocoding_error TEXT NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (
    tenant_id,
    appointment_id,
    location_type
  )
);

CREATE INDEX IF NOT EXISTS appointment_locations_tenant_appointment_idx
  ON appointment_locations (
    tenant_id,
    appointment_id
  );

CREATE INDEX IF NOT EXISTS appointment_locations_geocoding_status_idx
  ON appointment_locations (
    tenant_id,
    geocoding_status
  );

CREATE TABLE IF NOT EXISTS appointment_resource_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  appointment_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,

  assignment_role TEXT NOT NULL DEFAULT 'primary',
  assignment_status TEXT NOT NULL DEFAULT 'assigned',

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (
    tenant_id,
    appointment_id,
    resource_id,
    assignment_role
  )
);

CREATE INDEX IF NOT EXISTS appointment_resource_assignments_resource_idx
  ON appointment_resource_assignments (
    tenant_id,
    resource_id,
    assignment_status
  );

CREATE INDEX IF NOT EXISTS appointment_resource_assignments_appointment_idx
  ON appointment_resource_assignments (
    tenant_id,
    appointment_id
  );

CREATE TABLE IF NOT EXISTS route_plans (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,

  service_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  mode TEXT NOT NULL DEFAULT 'view_only',

  routing_provider TEXT NULL,

  total_distance_meters BIGINT NOT NULL DEFAULT 0,
  total_drive_seconds BIGINT NOT NULL DEFAULT 0,
  total_service_seconds BIGINT NOT NULL DEFAULT 0,

  optimization_request JSONB NOT NULL DEFAULT '{}'::jsonb,
  optimization_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  calculation_started_at TIMESTAMPTZ NULL,
  calculation_finished_at TIMESTAMPTZ NULL,
  error_code TEXT NULL,
  error_details JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (
    tenant_id,
    resource_id,
    service_date
  )
);

CREATE INDEX IF NOT EXISTS route_plans_tenant_date_idx
  ON route_plans (
    tenant_id,
    service_date
  );

CREATE INDEX IF NOT EXISTS route_plans_resource_date_idx
  ON route_plans (
    tenant_id,
    resource_id,
    service_date
  );

CREATE TABLE IF NOT EXISTS route_plan_stops (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  route_plan_id TEXT NOT NULL,

  appointment_id TEXT NULL,
  location_id TEXT NOT NULL,

  stop_type TEXT NOT NULL DEFAULT 'service',
  stop_order INTEGER NOT NULL,

  planned_arrival_at TIMESTAMPTZ NULL,
  planned_departure_at TIMESTAMPTZ NULL,

  service_duration_seconds INTEGER NOT NULL DEFAULT 0,
  drive_seconds_from_previous INTEGER NOT NULL DEFAULT 0,
  distance_meters_from_previous BIGINT NOT NULL DEFAULT 0,

  is_locked BOOLEAN NOT NULL DEFAULT FALSE,

  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (
    route_plan_id,
    stop_order
  )
);

CREATE INDEX IF NOT EXISTS route_plan_stops_plan_order_idx
  ON route_plan_stops (
    route_plan_id,
    stop_order
  );

CREATE INDEX IF NOT EXISTS route_plan_stops_appointment_idx
  ON route_plan_stops (
    tenant_id,
    appointment_id
  );

CREATE TABLE IF NOT EXISTS route_calculation_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  route_plan_id TEXT NULL,

  calculation_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  routing_provider TEXT NULL,

  input_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_payload JSONB NOT NULL DEFAULT '{}'::jsonb,

  error_code TEXT NULL,
  error_details JSONB NOT NULL DEFAULT '{}'::jsonb,

  started_at TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL,
  duration_ms INTEGER NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS route_calculation_runs_tenant_created_idx
  ON route_calculation_runs (
    tenant_id,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS route_calculation_runs_plan_idx
  ON route_calculation_runs (
    tenant_id,
    route_plan_id
  );

COMMIT;