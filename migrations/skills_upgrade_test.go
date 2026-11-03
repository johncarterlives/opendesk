package migrations_test

import (
	"testing"

	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/useopendesk/opendesk/migrations"
)

func TestSkillsMigrationAvailableAfterDeployedVersion(t *testing.T) {
	source, err := iofs.New(migrations.FS, ".")
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	// Instances on the current main have already applied version 702.
	for version, err := source.Next(702); err == nil; version, err = source.Next(version) {
		body, name, err := source.ReadUp(version)
		if err != nil {
			t.Fatal(err)
		}
		body.Close()
		if name == "ticket_skills" {
			return
		}
	}
	t.Fatal("upgrade from deployed version 702 does not apply the ticket skills schema")
}
