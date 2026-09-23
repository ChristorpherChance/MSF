import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand } from '../evidence/command-bus.js';

export interface Project {
  id: string;
  name: string;
  status: 'active' | 'archived';
  is_demo: boolean;
  created_at: string;
  created_by: string;
}

/** M13 平台管理（最小集）：项目 CRUD，全部写经命令事务（BR-04） */
@Injectable()
export class ProjectsService {
  onModuleInit(): void {
    registerCommand('platform.project.create', async (client, payload) => {
      const { name, isDemo } = payload as { name: string; isDemo?: boolean };
      if (!name) throw new DomainError('VALIDATION_FAILED', '项目名必填', 'name');
      const id = randomUUID();
      await client.query('INSERT INTO projects (id, name, is_demo) VALUES ($1, $2, $3)', [id, name, isDemo ?? false]);
      return { id };
    });
    registerCommand('platform.project.archive', async (client, payload) => {
      const { id } = payload as { id: string };
      const r = await client.query(
        "UPDATE projects SET status='archived' WHERE id=$1 AND status='active'",
        [id],
      );
      if (r.rowCount === 0) throw new DomainError('NOT_FOUND', '项目不存在或已归档', id);
      return { id, status: 'archived' };
    });
  }

  async create(name: string, isDemo = false): Promise<{ id: string }> {
    return (await executeCommand(
      'platform.project.create',
      { name, isDemo },
      { projectId: null, actorKind: 'human', actorId: 'local' },
    )) as { id: string };
  }

  async archive(id: string): Promise<unknown> {
    return executeCommand(
      'platform.project.archive',
      { id },
      { projectId: id, actorKind: 'human', actorId: 'local' },
    );
  }

  async list(): Promise<Project[]> {
    const r = await query<Project>('SELECT * FROM projects ORDER BY created_at DESC');
    return r.rows;
  }

  async get(id: string): Promise<Project> {
    const r = await query<Project>('SELECT * FROM projects WHERE id=$1', [id]);
    const row = r.rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '项目不存在', id);
    return row;
  }
}
