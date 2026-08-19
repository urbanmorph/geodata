-- collect Phase 5: per-record provenance.
-- `source` distinguishes field-collected records (NULL — the contributor's own
-- observation) from bulk-imported records (the source the importer attested at
-- import time). Per-record, so ONE collection can honestly mix collected +
-- imported data, and publish can credit field contributors and imported sources
-- separately in the attribution.
ALTER TABLE records ADD COLUMN source TEXT;
