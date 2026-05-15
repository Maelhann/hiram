import cron from 'node-cron';
import type { Supervisor } from './supervisor.js';
import type { BackupService } from './backup.js';

export class Scheduler {
  private tasks: cron.ScheduledTask[] = [];

  constructor(
    private supervisor: Supervisor,
    private backup: BackupService,
  ) {}

  start(): void {
    // Daily planning at 06:00
    this.tasks.push(
      cron.schedule('0 6 * * *', () => {
        this.supervisor.runDailyPlanning().catch(console.error);
      })
    );

    // Backup every 6 hours: midnight, 06:00, 12:00, 18:00
    this.tasks.push(
      cron.schedule('0 0,6,12,18 * * *', () => {
        this.backup.run().catch(console.error);
      })
    );
  }

  stop(): void {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
  }
}
