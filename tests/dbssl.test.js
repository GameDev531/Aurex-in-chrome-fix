// TLS da conexão com o banco.
//
// Achado do scanner (bypass-tls-verification), e ele estava certo: a conexão
// usava `rejectUnauthorized: false` sempre que DATABASE_SSL=true. O nome da
// flag promete segurança e entregava criptografia SEM autenticação do
// servidor — ou seja, um man-in-the-middle passa despercebido, com o banco de
// credenciais de usuário do outro lado.
const path = require('node:path');
const { check, equal, group, ROOT } = require('./harness');

const dbModule = path.join(ROOT, 'server', 'src', 'db.js');

group('TLS do banco: desligado por padrão', async () => {
  const { resolveDbSsl } = await import(dbModule);
  equal('sem a variável, sem TLS', resolveDbSsl({}, () => {}), false);
  equal('"false" não liga', resolveDbSsl({ DATABASE_SSL: 'false' }, () => {}), false);
  equal('valor estranho não liga', resolveDbSsl({ DATABASE_SSL: 'sim' }, () => {}), false);
});

group('TLS do banco: ligado significa VERIFICADO', async () => {
  const { resolveDbSsl } = await import(dbModule);

  const ssl = resolveDbSsl({ DATABASE_SSL: 'true' }, () => {});
  check('vira objeto de configuração', typeof ssl === 'object' && ssl !== null);
  equal('o certificado É verificado', ssl.rejectUnauthorized, true);

  const req = resolveDbSsl({ DATABASE_SSL: 'require' }, () => {});
  equal('"require" também verifica', req.rejectUnauthorized, true);

  const comCa = resolveDbSsl({ DATABASE_SSL: 'true', DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----' }, () => {});
  equal('CA própria é repassada', comCa.ca, '-----BEGIN CERTIFICATE-----');
  equal('e continua verificando', comCa.rejectUnauthorized, true);
});

group('TLS do banco: desligar a verificação exige variável própria e avisa', async () => {
  const { resolveDbSsl } = await import(dbModule);

  // A variável de escape sozinha não faz nada: sem TLS não há o que verificar.
  equal('escape sem TLS ligado não faz nada',
    resolveDbSsl({ DATABASE_SSL_INSECURE: 'true' }, () => {}), false);

  const avisos = [];
  const inseguro = resolveDbSsl(
    { DATABASE_SSL: 'true', DATABASE_SSL_INSECURE: 'true' },
    (m) => avisos.push(m)
  );
  equal('só então a verificação cai', inseguro.rejectUnauthorized, false);
  check('e o servidor grita no log', avisos.length === 1 && /NÃO será verificado/.test(avisos[0]), avisos[0]);

  // Regressão exata: DATABASE_SSL=true sozinho NUNCA pode voltar a significar
  // "criptografado mas sem verificar".
  const soTls = resolveDbSsl({ DATABASE_SSL: 'true' }, () => {});
  check('DATABASE_SSL=true sozinho não desliga a verificação', soTls.rejectUnauthorized !== false);
});
