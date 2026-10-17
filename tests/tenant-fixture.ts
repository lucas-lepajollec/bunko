import { tenantContext } from '@/lib/tenant-context';
import { accountsDb } from '@/lib/accounts-store';
/** Existing integration fixtures exercise one explicitly selected private instance. */
export function enterFixtureTenant(createAccount = true) {
  tenantContext.enterWith({ id: 1 });
  if (createAccount) {
    accountsDb()
      .prepare(
        `INSERT OR IGNORE INTO users(id,username,role,password_hash,session_epoch,created_at)
      VALUES(1,'FixtureAdmin','admin','fixture-hash','fixture-epoch','2026-01-01')`,
      )
      .run();
    accountsDb().prepare("INSERT OR IGNORE INTO account_state VALUES('token_user','1')").run();
  }
}
