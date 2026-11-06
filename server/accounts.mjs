import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
export const fail = (status, message) => Object.assign(new Error(message), { status });
const derive = promisify(scrypt);
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const equal = (a, b) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const pair = (a, b) => [a, b].sort();
const publicUser = (u) =>
  u && {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    bio: u.bio,
    city: u.city,
    role: u.role,
    createdAt: u.created_at,
  };
export function createAccounts(db, { now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,bio TEXT NOT NULL DEFAULT '',city TEXT NOT NULL DEFAULT '',password TEXT NOT NULL,role TEXT NOT NULL,space TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS session_users ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS invitations(hash TEXT PRIMARY KEY,created_by TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL,used_by TEXT REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS contacts(a TEXT NOT NULL REFERENCES users(id),b TEXT NOT NULL REFERENCES users(id),requester TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(a,b));
    CREATE TABLE IF NOT EXISTS direct_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,sender TEXT NOT NULL REFERENCES users(id),recipient TEXT NOT NULL REFERENCES users(id),content TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(sender,id));
    CREATE INDEX IF NOT EXISTS dm_pair ON direct_messages(sender,recipient,seq);
    CREATE TABLE IF NOT EXISTS direct_message_reads(owner TEXT NOT NULL REFERENCES users(id),contact TEXT NOT NULL REFERENCES users(id),seq INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,contact));
    CREATE TABLE IF NOT EXISTS locations(user_id TEXT PRIMARY KEY REFERENCES users(id),latitude REAL NOT NULL,longitude REAL NOT NULL,accuracy REAL NOT NULL,updated_at TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS pi_turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,owner TEXT NOT NULL REFERENCES users(id),conversation_id TEXT NOT NULL,input TEXT NOT NULL,output TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(owner,id));
    CREATE INDEX IF NOT EXISTS pi_owner ON pi_turns(owner,conversation_id,seq);`);
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(pi_turns)')
      .all()
      .map((c) => c.name),
  );
  for (const [name, type] of [
    ['project_id', 'TEXT'],
    ['access', 'TEXT'],
    ['tools', 'TEXT'],
    ['thinking', 'TEXT'],
    ['timeline', 'TEXT'],
    ['attachments', 'TEXT'],
    ['artifacts', 'TEXT'],
    ['supplements', 'TEXT'],
    ['execution', 'TEXT'],
  ])
    if (!columns.has(name)) db.exec(`ALTER TABLE pi_turns ADD COLUMN ${name} ${type}`);
  db.exec(
    `CREATE TABLE IF NOT EXISTS pi_jobs(owner TEXT NOT NULL,id TEXT NOT NULL,conversation_id TEXT NOT NULL,project_id TEXT NOT NULL,access TEXT NOT NULL,input TEXT NOT NULL,status TEXT NOT NULL,tools TEXT NOT NULL DEFAULT '[]',error TEXT,created_at TEXT NOT NULL,PRIMARY KEY(owner,id));`,
  );
  db.prepare(
    "UPDATE pi_jobs SET status='interrupted',error='服务重启，任务结果未确认；请检查文件后再发起新任务。' WHERE status='running'",
  ).run();
  let hashing = 0;
  async function hash(password, encoded) {
    if (hashing >= 2) throw fail(429, '登录请求较多，请稍后重试。');
    hashing++;
    try {
      const salt = encoded?.split(':')[0] || randomBytes(16).toString('hex');
      const key = await derive(password, salt, 32, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      });
      return `${salt}:${key.toString('hex')}`;
    } finally {
      hashing--;
    }
  }
  function get(id) {
    return db.prepare('SELECT * FROM users WHERE id=?').get(id);
  }
  function session(user) {
    const token = randomBytes(32).toString('base64url'),
      expires = now() + 30 * 86400000;
    db.prepare('DELETE FROM sessions WHERE expires<=?').run(now());
    // 每个账号最多保留 20 个设备会话。
    db.prepare(
      'DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE user_id=? ORDER BY expires DESC LIMIT -1 OFFSET 19)',
    ).run(user.id);
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), user.id, expires);
    return { token, user: publicUser(user), expiresAt: new Date(expires).toISOString() };
  }
  function requireContact(id, other) {
    const [a, b] = pair(id, other);
    if (!db.prepare("SELECT 1 FROM contacts WHERE a=? AND b=? AND status='accepted'").get(a, b))
      throw fail(403, '仅已接受的联系人可以聊天或查看共享位置。');
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return {
    initialized: () => !!db.prepare('SELECT 1 FROM users LIMIT 1').get(),
    async register(p, bootstrap = false) {
      // 在昂贵的密码派生前先核对邀请，事务内再次核对以防并发重复使用。
      const check = () => {
        if (bootstrap) {
          if (this.initialized()) throw fail(409, '管理员账号已经建立，请直接登录。');
        } else if (
          !db
            .prepare('SELECT 1 FROM invitations WHERE hash=? AND used_by IS NULL AND expires>?')
            .get(digest(p.invite), now())
        )
          throw fail(403, '邀请码无效、已使用或已过期。');
        if (db.prepare('SELECT 1 FROM users WHERE username=?').get(p.username))
          throw fail(409, '这个用户名已被使用。');
      };
      check();
      const password = await hash(p.password),
        id = randomUUID();
      transaction(() => {
        check();
        db.prepare(
          'INSERT INTO users(id,username,display_name,password,role,space,created_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          id,
          p.username,
          p.displayName,
          password,
          bootstrap ? 'owner' : 'member',
          bootstrap ? 'legacy' : id,
          new Date(now()).toISOString(),
        );
        if (!bootstrap)
          db.prepare('UPDATE invitations SET used_by=? WHERE hash=?').run(id, digest(p.invite));
      });
      return session(get(id));
    },
    async login(p) {
      const u = db.prepare('SELECT * FROM users WHERE username=?').get(p.username);
      const encoded =
        u?.password ||
        '00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000';
      const candidate = await hash(p.password, encoded);
      if (!u || !equal(candidate, encoded)) throw fail(401, '用户名或密码不正确。');
      return session(u);
    },
    authenticate(token) {
      const row = db
        .prepare(
          'SELECT users.*,sessions.hash AS session_hash FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires>?',
        )
        .get(digest(token), now());
      return row ? { ...publicUser(row), space: row.space, sessionHash: row.session_hash } : null;
    },
    logout(actor) {
      db.prepare('DELETE FROM sessions WHERE hash=?').run(actor.sessionHash);
    },
    profile(id) {
      return publicUser(get(id));
    },
    updateProfile(id, p) {
      db.prepare('UPDATE users SET display_name=?,bio=?,city=? WHERE id=?').run(
        p.displayName,
        p.bio,
        p.city,
        id,
      );
      return publicUser(get(id));
    },
    async changePassword(actor, p) {
      const u = get(actor.id);
      if (!equal(await hash(p.oldPassword, u.password), u.password))
        throw fail(401, '原密码不正确。');
      const next = await hash(p.password);
      transaction(() => {
        db.prepare('UPDATE users SET password=? WHERE id=?').run(next, u.id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
      });
      return session(get(u.id));
    },
    invite(actor) {
      if (actor.role !== 'owner') throw fail(403, '只有管理员可以创建邀请码。');
      db.prepare('DELETE FROM invitations WHERE expires<=? OR used_by IS NOT NULL').run(now());
      if (db.prepare('SELECT COUNT(*) AS n FROM invitations WHERE used_by IS NULL').get().n >= 50)
        throw fail(429, '尚有未使用的邀请码，请稍后再创建。');
      const code = randomBytes(12).toString('hex'),
        expires = now() + 7 * 86400000;
      db.prepare('INSERT INTO invitations(hash,created_by,expires) VALUES(?,?,?)').run(
        digest(code),
        actor.id,
        expires,
      );
      return { code, expiresAt: new Date(expires).toISOString() };
    },
    request(id, username) {
      const other = db.prepare('SELECT id FROM users WHERE username=?').get(username);
      if (!other || other.id === id) throw fail(404, '未找到可添加的账号，请核对完整用户名。');
      const [a, b] = pair(id, other.id);
      const old = db.prepare('SELECT * FROM contacts WHERE a=? AND b=?').get(a, b);
      if (old)
        throw fail(
          409,
          old.status === 'accepted' ? '对方已是联系人。' : '已存在联系人申请，请到申请列表处理。',
        );
      if (db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE a=? OR b=?').get(id, id).n >= 200)
        throw fail(429, '联系人与待处理申请已达上限。');
      db.prepare("INSERT INTO contacts VALUES(?,?,?,'pending',?)").run(
        a,
        b,
        id,
        new Date(now()).toISOString(),
      );
    },
    respond(id, other, accept) {
      const [a, b] = pair(id, other);
      const c = db.prepare('SELECT * FROM contacts WHERE a=? AND b=?').get(a, b);
      if (!c || c.status !== 'pending' || c.requester === id) throw fail(404, '没有待处理的申请。');
      if (accept) db.prepare("UPDATE contacts SET status='accepted' WHERE a=? AND b=?").run(a, b);
      else db.prepare('DELETE FROM contacts WHERE a=? AND b=?').run(a, b);
    },
    removeContact(id, other) {
      const [a, b] = pair(id, other);
      db.prepare('DELETE FROM contacts WHERE a=? AND b=?').run(a, b);
    },
    overview(id) {
      db.prepare('DELETE FROM locations WHERE expires<=?').run(now());
      const contacts = [],
        incoming = [],
        outgoing = [];
      for (const c of db.prepare('SELECT * FROM contacts WHERE a=? OR b=?').all(id, id)) {
        const u = get(c.a === id ? c.b : c.a);
        if (c.status === 'accepted') {
          const latest = db
            .prepare(
              'SELECT content,created_at FROM direct_messages WHERE (sender=? AND recipient=?) OR (sender=? AND recipient=?) ORDER BY seq DESC LIMIT 1',
            )
            .get(id, u.id, u.id, id);
          contacts.push({
            ...publicUser(u),
            unread: this.unreadMessages(id, u.id),
            latest: latest ? { content: latest.content, createdAt: latest.created_at } : null,
          });
        } else
          (c.requester === id ? outgoing : incoming).push({
            id: u.id,
            username: u.username,
            displayName: u.display_name,
          });
      }
      const locations = db
        .prepare(
          `SELECT l.* FROM locations l WHERE l.user_id=? OR EXISTS(SELECT 1 FROM contacts c WHERE c.status='accepted' AND ((c.a=? AND c.b=l.user_id) OR (c.b=? AND c.a=l.user_id)))`,
        )
        .all(id, id, id)
        .map((l) => ({
          userId: l.user_id,
          latitude: l.latitude,
          longitude: l.longitude,
          accuracy: l.accuracy,
          updatedAt: l.updated_at,
          expiresAt: new Date(l.expires).toISOString(),
        }));
      return { me: publicUser(get(id)), contacts, incoming, outgoing, locations };
    },
    unreadMessages(id, other) {
      return db
        .prepare(
          'SELECT count(*) n FROM direct_messages m WHERE recipient=? AND sender=? AND seq>COALESCE((SELECT seq FROM direct_message_reads WHERE owner=? AND contact=?),0)',
        )
        .get(id, other, id, other).n;
    },
    unread(id) {
      const contacts = db
        .prepare('SELECT a,b,status,requester FROM contacts WHERE a=? OR b=?')
        .all(id, id);
      return {
        messages: contacts
          .filter((c) => c.status === 'accepted')
          .reduce((n, c) => n + this.unreadMessages(id, c.a === id ? c.b : c.a), 0),
        requests: contacts.filter((c) => c.status === 'pending' && c.requester !== id).length,
      };
    },
    readMessages(id, other, through) {
      requireContact(id, other);
      if (
        through &&
        !db
          .prepare(
            'SELECT 1 FROM direct_messages WHERE seq=? AND ((sender=? AND recipient=?) OR (sender=? AND recipient=?))',
          )
          .get(through, id, other, other, id)
      )
        throw fail(400, '已读位置不属于此对话。');
      db.prepare(
        'INSERT INTO direct_message_reads VALUES(?,?,?) ON CONFLICT(owner,contact) DO UPDATE SET seq=MAX(seq,excluded.seq)',
      ).run(id, other, through);
      return { unread: this.unreadMessages(id, other) };
    },
    messages(id, other, before = Number.MAX_SAFE_INTEGER) {
      requireContact(id, other);
      return db
        .prepare(
          'SELECT * FROM direct_messages WHERE ((sender=? AND recipient=?) OR (sender=? AND recipient=?)) AND seq<? ORDER BY seq DESC LIMIT 100',
        )
        .all(id, other, other, id, before)
        .reverse()
        .map((m) => ({
          seq: m.seq,
          id: m.id,
          senderId: m.sender,
          recipientId: m.recipient,
          content: m.content,
          createdAt: m.created_at,
        }));
    },
    send(id, other, p) {
      requireContact(id, other);
      const old = db.prepare('SELECT * FROM direct_messages WHERE sender=? AND id=?').get(id, p.id);
      if (old && (old.recipient !== other || old.content !== p.content))
        throw fail(409, '消息编号已存在不同内容。');
      if (!old)
        db.prepare(
          'INSERT INTO direct_messages(id,sender,recipient,content,created_at) VALUES(?,?,?,?,?)',
        ).run(p.id, id, other, p.content, new Date(now()).toISOString());
      return this.messages(id, other);
    },
    shareLocation(id, p) {
      const latitude = Math.round(p.latitude * 1000) / 1000,
        longitude = Math.round(p.longitude * 1000) / 1000;
      db.prepare(
        'INSERT INTO locations VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET latitude=excluded.latitude,longitude=excluded.longitude,accuracy=excluded.accuracy,updated_at=excluded.updated_at,expires=excluded.expires',
      ).run(
        id,
        latitude,
        longitude,
        Math.max(p.accuracy, 150),
        new Date(now()).toISOString(),
        now() + p.ttlMinutes * 60000,
      );
    },
    stopLocation(id) {
      db.prepare('DELETE FROM locations WHERE user_id=?').run(id);
    },
    piConversations(id) {
      return db
        .prepare(
          'SELECT conversation_id AS id,MIN(created_at) AS createdAt,MAX(created_at) AS updatedAt FROM pi_turns WHERE owner=? GROUP BY conversation_id ORDER BY updatedAt DESC LIMIT 2000',
        )
        .all(id)
        .map((c) => ({
          ...c,
          ...this.piScope(id, c.id),
          title: db
            .prepare(
              'SELECT input FROM pi_turns WHERE owner=? AND conversation_id=? ORDER BY seq LIMIT 1',
            )
            .get(id, c.id)
            .input.slice(0, 40),
        }));
    },
    piHistory(id, conversation, before = Number.MAX_SAFE_INTEGER) {
      return db
        .prepare(
          'SELECT seq,id,input,output,project_id AS projectId,access,tools,thinking,timeline,attachments,artifacts,supplements,execution,created_at AS createdAt FROM pi_turns WHERE owner=? AND conversation_id=? AND seq<? ORDER BY seq DESC LIMIT 50',
        )
        .all(id, conversation, before)
        .reverse()
        .map((t) => ({
          ...t,
          tools: JSON.parse(t.tools || '[]'),
          timeline: JSON.parse(t.timeline || '[]'),
          attachments: JSON.parse(t.attachments || '[]'),
          artifacts: JSON.parse(t.artifacts || '[]'),
          supplements: JSON.parse(t.supplements || '[]'),
          execution: JSON.parse(t.execution || 'null'),
        }));
    },
    piTranscript(id, conversation) {
      return db
        .prepare(
          'SELECT input,output,supplements FROM pi_turns WHERE owner=? AND conversation_id=? ORDER BY seq',
        )
        .all(id, conversation)
        .flatMap((t) => [
          { role: 'user', content: t.input },
          ...JSON.parse(t.supplements || '[]').map((s) => ({ role: 'user', content: s.input })),
          { role: 'assistant', content: t.output },
        ]);
    },
    piTurn(id, requestId) {
      return db.prepare('SELECT * FROM pi_turns WHERE owner=? AND id=?').get(id, requestId);
    },
    piScope(id, conversation) {
      const row = db
        .prepare(
          'SELECT project_id AS projectId,access FROM pi_turns WHERE owner=? AND conversation_id=? ORDER BY seq DESC LIMIT 1',
        )
        .get(id, conversation);
      return row ? { projectId: row.projectId || null, access: row.access || 'read' } : null;
    },
    piJob(id, requestId) {
      const row = db
        .prepare(
          'SELECT id,conversation_id AS conversationId,project_id AS projectId,access,input,status,tools,error,created_at AS createdAt FROM pi_jobs WHERE owner=? AND id=?',
        )
        .get(id, requestId);
      return row ? { ...row, tools: JSON.parse(row.tools) } : null;
    },
    reservePiJob(id, p) {
      db.prepare(
        "INSERT INTO pi_jobs(owner,id,conversation_id,project_id,access,input,status,created_at) VALUES(?,?,?,?,?,?,'running',?)",
      ).run(
        id,
        p.id,
        p.conversationId,
        p.projectId,
        p.access,
        p.input,
        new Date(now()).toISOString(),
      );
    },
    finishPiJob(id, requestId, status, tools, errorMessage = null) {
      db.prepare('UPDATE pi_jobs SET status=?,tools=?,error=? WHERE owner=? AND id=?').run(
        status,
        JSON.stringify(tools),
        errorMessage,
        id,
        requestId,
      );
    },
    savePiTurn(id, p, output, tools = [], thinking = '', timeline = []) {
      db.prepare(
        'INSERT INTO pi_turns(id,owner,conversation_id,input,output,created_at,project_id,access,tools,thinking,timeline,attachments,artifacts,supplements,execution) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        p.id,
        id,
        p.conversationId,
        p.input,
        output,
        new Date(now()).toISOString(),
        p.projectId || null,
        p.access || 'read',
        JSON.stringify(tools),
        thinking,
        JSON.stringify(timeline),
        JSON.stringify(p.attachments || []),
        JSON.stringify(p.artifacts || []),
        JSON.stringify(p.supplements || []),
        JSON.stringify(p.execution || null),
      );
    },
    deletePiConversation(id, conversation) {
      db.prepare('DELETE FROM pi_turns WHERE owner=? AND conversation_id=?').run(id, conversation);
    },
  };
}
