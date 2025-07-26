const express = require('express');
const cors = require('cors');
const sql = require('mssql');

const app = express();

// Middleware ayarları
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// SQL Server bağlantı ayarları
const dbConfig = {
  user: 'Emind',
  password: 'emin123',
  server: 'localhost',
  database: 'Hastane',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  }
};

// Bağlantı havuzu
let pool;
async function initializeDatabase() {
  try {
    pool = await new sql.ConnectionPool(dbConfig).connect();
    console.log('✅ SQL Server bağlantısı başarılı');
  } catch (err) {
    console.error('❌ SQL Server bağlantı hatası:', err.message, err.stack);
    console.error('Hata detayı:', err.originalError?.info?.message || err.message);
    process.exit(1);
  }
}
initializeDatabase();

// Test endpoint'i
app.get('/api/test', (req, res) => {
  res.json({
    status: 'API çalışıyor',
    database: pool.connected ? 'Bağlı' : 'Bağlı değil',
    timestamp: new Date()
  });
});

// Hastane listesi endpoint'i
app.get('/api/hastaneler', async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT h.HastaneID, h.HAdi, h.TelNo, 
             a.Sehir, a.Ilce, a.Cadde, a.Sokak, a.ANo
      FROM Hastane h
      JOIN Adres a ON h.Adres_ID = a.Adres_ID
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Hastaneler yükleme hatası:', {
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ error: 'Hastaneler yüklenemedi', details: err.message });
  }
});

// Poliklinik listesi endpoint'i
app.get('/api/poliklinikler', async (req, res) => {
  const hastaneIdRaw = req.query.hastane;
  const hastaneId = parseInt(hastaneIdRaw, 10);

  if (isNaN(hastaneId)) {
    console.error('Geçersiz hastane ID:', hastaneIdRaw);
    return res.status(400).json({ 
      error: 'Geçersiz hastane ID. Örnek kullanım: /api/poliklinikler?hastane=1'
    });
  }

  try {
    const request = pool.request().input('HastaneID', sql.Int, hastaneId);

    // Hastane varlık kontrolü
    const hastaneKontrol = await request.query('SELECT HAdi FROM Hastane WHERE HastaneID = @HastaneID');
    if (hastaneKontrol.recordset.length === 0) {
      console.warn('Hastane bulunamadı:', hastaneId);
      return res.status(404).json({ error: 'Hastane bulunamadı' });
    }

    // Poliklinikleri getir
    const result = await request.query(`
      SELECT DISTINCT p.PID, p.PAdi
      FROM Poliklinik p
      INNER JOIN Hastane_Poliklinik_Doktor hpd ON p.PID = hpd.PID
      WHERE hpd.HastaneID = @HastaneID
      ORDER BY p.PAdi
    `);

    res.json({
      hastane: hastaneKontrol.recordset[0].HAdi,
      poliklinikler: result.recordset
    });
  } catch (err) {
    console.error('Poliklinik sorgu hatası:', {
      error: err.message,
      stack: err.stack,
      hastaneId
    });
    res.status(500).json({ 
      error: 'Sunucu hatası',
      details: err.message
    });
  }
});

// Doktor listesi endpoint'i
app.get('/api/doktorlar', async (req, res) => {
  const { hastaneId, poliklinikId } = req.query;

  try {
    const request = pool.request();
    let query = `
      SELECT DISTINCT d.SicilNo, d.Ad, d.Soyad, b.Brans, h.HAdi, p.PAdi
      FROM Doktor d
      JOIN Brans b ON d.SicilNo = b.SicilNo
      JOIN Hastane_Poliklinik_Doktor hpd ON d.SicilNo = hpd.SicilNo
      JOIN Hastane h ON hpd.HastaneID = h.HastaneID
      JOIN Poliklinik p ON hpd.PID = p.PID
    `;

    if (hastaneId && poliklinikId) {
      query += ` WHERE hpd.HastaneID = @hastaneId AND hpd.PID = @poliklinikId`;
      request.input('hastaneId', sql.Int, parseInt(hastaneId, 10));
      request.input('poliklinikId', sql.Int, parseInt(poliklinikId, 10));
    }

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error('Doktorlar yükleme hatası:', {
      error: err.message,
      stack: err.stack,
      hastaneId,
      poliklinikId
    });
    res.status(500).json({ error: 'Doktorlar yüklenemedi', details: err.message });
  }
});

// Müsait saatler endpoint'i
app.get('/api/musait-saatler', async (req, res) => {
  const { doktorId,poliklinikId ,tarih } = req.query;

  if (!doktorId || !tarih || !poliklinikId) {
    console.error('Eksik parametreler:', { doktorId, tarih, poliklinikId });
    return res.status(400).json({ error: 'Doktor ID, poliklinik ID ve tarih gereklidir' });
  }

  try {
    const inputDate = new Date(tarih);
    if (isNaN(inputDate.getTime())) {
      console.error('Geçersiz tarih:', tarih);
      return res.status(400).json({ error: 'Geçersiz tarih formatı (ör: 2025-05-25)' });
    }

    const startDate = new Date(inputDate);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(inputDate);
    endDate.setHours(23, 59, 59, 999);

    const request = pool.request()
      .input('DoktorId', sql.Int, parseInt(doktorId, 10))
      .input('PoliklinikId', sql.Int, parseInt(poliklinikId, 10))
      .input('StartDate', sql.DateTime, startDate)
      .input('EndDate', sql.DateTime, endDate);

    const randevular = await request.query(`
      SELECT FORMAT(R_Tarih, 'HH:mm') AS saat
      FROM Randevu 
      WHERE (SicilNo = @DoktorId OR PID = @PoliklinikId)
      AND R_Tarih BETWEEN @StartDate AND @EndDate
    `);

    const tumSaatler = [];
    for (let hour = 9; hour <= 16; hour++) {
      tumSaatler.push(`${hour.toString().padStart(2, '0')}:00`);
      if (hour < 16) tumSaatler.push(`${hour.toString().padStart(2, '0')}:30`);
    }

    const doluSaatler = randevular.recordset.map(r => r.saat);
    const musaitSaatler = tumSaatler.map(saat => ({
      time: saat,
      available: !doluSaatler.includes(saat)
    }));

    res.json(musaitSaatler);
  } catch (err) {
    console.error('Müsait saatler yükleme hatası:', {
      error: err.message,
      stack: err.stack,
      doktorId,
      tarih,
      poliklinikId
    });
    res.status(500).json({ 
      error: 'Müsait saatler yüklenemedi',
      details: err.message 
    });
  }
});

// Hasta oluşturma endpoint'i
app.post('/api/hasta', async (req, res) => {
  const { TC, Ad, Soyad, DogumTarihi, Cinsiyet, TelNo } = req.body;

  // Zorunlu alanların kontrolü
  if (!TC || !/^\d{11}$/.test(TC)) {
    console.error('Geçersiz TC:', TC);
    return res.status(400).json({ error: 'Geçerli bir TC Kimlik No giriniz (11 haneli)' });
  }

  if (!Ad || !Soyad || !DogumTarihi || !Cinsiyet || !TelNo) {
    console.error('Eksik alanlar:', { TC, Ad, Soyad, DogumTarihi, Cinsiyet, TelNo });
    return res.status(400).json({ error: 'TC, Ad, Soyad, Doğum Tarihi, Cinsiyet ve Telefon zorunludur' });
  }

  const dogumTarihiDate = new Date(DogumTarihi);
  if (isNaN(dogumTarihiDate.getTime())) {
    console.error('Geçersiz doğum tarihi:', DogumTarihi);
    return res.status(400).json({ error: 'Geçersiz doğum tarihi formatı' });
  }

  if (!/^\d{10,15}$/.test(TelNo)) {
    console.error('Geçersiz telefon numarası:', TelNo);
    return res.status(400).json({ error: 'Telefon numarası 10-15 haneli olmalıdır' });
  }

  if (!['E', 'K'].includes(Cinsiyet)) {
    console.error('Geçersiz cinsiyet:', Cinsiyet);
    return res.status(400).json({ error: 'Cinsiyet "E" veya "K" olmalıdır' });
  }

  let transaction;
  try {
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const request = new sql.Request(transaction);

    // Tüm parametreleri bir kere tanımla
    request.input('TC', sql.Char(11), TC);
    request.input('Ad', sql.VarChar(50), Ad);
    request.input('Soyad', sql.VarChar(50), Soyad);
    request.input('Cinsiyet', sql.Char(1), Cinsiyet);
    request.input('DogumTarihi', sql.Date, dogumTarihiDate);
    request.input('TelNo', sql.VarChar(11), TelNo);

    // Aynı TC ile kayıt kontrolü
    const existingPatient = await request.query('SELECT * FROM Hasta WHERE TC = @TC');
    if (existingPatient.recordset.length > 0) {
      await transaction.rollback();
      console.warn('Mevcut hasta:', TC);
      return res.status(409).json({ error: 'Bu TC kimlik numarası ile kayıtlı bir hasta zaten var' });
    }

    // Yeni hasta kaydı oluştur
    await request.query(`
      INSERT INTO Hasta (TC, Ad, Soyad, Cinsiyet, DogumTarihi)
      VALUES (@TC, @Ad, @Soyad, @Cinsiyet, @DogumTarihi)
    `);

    // Telefon numarasını Hasta_TEL tablosuna ekle
    await request.query(`
      INSERT INTO Hasta_TEL (TC, Tel_No)
      VALUES (@TC, @TelNo)`);

    await transaction.commit();
    console.log(`Yeni hasta kaydı eklendi: ${Ad} ${Soyad} (TC: ${TC}, Tel: ${TelNo})`);
    res.status(201).json({ message: 'Hasta başarıyla kaydedildi', tc: TC });
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error('Hasta ekleme hatası:', {
      error: err.message,
      stack: err.stack,
      requestBody: req.body,
      sqlError: err.originalError?.info?.message || err.message
    });
    res.status(500).json({ 
      error: 'Hasta eklenirken bir hata oluştu',
      details: err.message,
      sqlError: err.originalError?.info?.message || err.message
    });
  }
});

// Randevu oluşturma endpoint'i
app.post('/api/randevu', async (req, res) => {
  const { tc, doktorId, poliklinikId, tarih } = req.body;

  if (!tc || !doktorId || !poliklinikId || !tarih) {
    console.error('Eksik alanlar:', { tc, doktorId, poliklinikId, tarih });
    return res.status(400).json({ error: 'TC, doktor ID, poliklinik ID ve tarih gereklidir' });
  }

  if (!/^\d{11}$/.test(tc)) {
    console.error('Geçersiz TC:', tc);
    return res.status(400).json({ error: 'TC Kimlik No 11 haneli olmalıdır' });
  }

  const parsedDoktorId = parseInt(doktorId, 10);
  const parsedPoliklinikId = parseInt(poliklinikId, 10);
  if (isNaN(parsedDoktorId) || isNaN(parsedPoliklinikId)) {
    console.error('Geçersiz ID:', { doktorId, poliklinikId });
    return res.status(400).json({ error: 'Doktor ID ve Poliklinik ID geçerli tamsayılar olmalıdır' });
  }

  const randevuTarihi = new Date(tarih);
  if (isNaN(randevuTarihi.getTime())) {
    console.error('Geçersiz tarih:', tarih);
    return res.status(400).json({ error: 'Geçersiz tarih formatı (ör: 2025-05-14T08:30:00.000Z)' });
  }

  let transaction;
  try {
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const request = new sql.Request(transaction);

    // Parametreleri tanımla
    request.input('TC', sql.Char(11), tc);
    request.input('SicilNo', sql.Int, parsedDoktorId);
    request.input('PID', sql.Int, parsedPoliklinikId);
    request.input('R_Tarih', sql.DateTime, randevuTarihi);

    // Hasta varlığını kontrol et
    console.log('Hasta kontrol ediliyor:', { TC: tc });
    const hastaKontrol = await request.query('SELECT 1 FROM Hasta WHERE TC = @TC');
    if (hastaKontrol.recordset.length === 0) {
      throw new Error(`Hasta bulunamadı (TC: ${tc})`);
    }

    // Doktor ve poliklinik varlığını kontrol et
    console.log('Doktor ve poliklinik kontrol ediliyor:', { SicilNo: parsedDoktorId, PID: parsedPoliklinikId });
    const doktorKontrol = await request.query(`
      SELECT 1 
      FROM Hastane_Poliklinik_Doktor hpd 
      WHERE hpd.SicilNo = @SicilNo AND hpd.PID = @PID
    `);
    if (doktorKontrol.recordset.length === 0) {
      throw new Error(`Doktor (SicilNo: ${parsedDoktorId}) veya poliklinik (PID: ${parsedPoliklinikId}) bulunamadı`);
    }

    // Yeni RID oluştur
    console.log('Yeni RID oluşturuluyor...');
    const lastId = await request.query('SELECT ISNULL(MAX(RID), 0) + 1 AS newRID FROM Randevu');
    const newRID = lastId.recordset[0].newRID;
    console.log('Yeni RID:', newRID);

    // Randevuyu ekle
    console.log('Randevu ekleniyor:', { RID: newRID, TC: tc, SicilNo: parsedDoktorId, PID: parsedPoliklinikId, R_Tarih: randevuTarihi });
    await request
      .input('RID', sql.Int, newRID)
      .query(`
        INSERT INTO Randevu (RID, R_Tarih, TC, SicilNo, PID)
        VALUES (@RID, @R_Tarih, @TC, @SicilNo, @PID)
      `);

    await transaction.commit();
    console.log('Randevu başarıyla oluşturuldu:', newRID);
    res.status(201).json({ 
      success: true,
      randevuId: newRID,
      message: 'Randevu başarıyla oluşturuldu'
    });
  } catch (err) {
    if (transaction) {
      console.log('Transaction geri alınıyor...');
      await transaction.rollback();
    }
    console.error('Randevu oluşturma hatası:', {
      error: err.message,
      stack: err.stack,
      requestBody: req.body
    });
    let errorDetails = err.message;
    if (err.message.includes('trg_RandevuKurallari')) {
      errorDetails = err.message.split('trg_RandevuKurallari: ')[1] || err.message;
    }
    res.status(400).json({ 
      error: 'Randevu oluşturulamadı',
      details: errorDetails
    });
  }
});

// Randevu listeleme endpoint'i
app.get('/api/randevu', async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query(`
      SELECT r.RID, FORMAT(r.R_Tarih, 'yyyy-MM-dd HH:mm') AS Tarih, 
             r.TC, h.Ad + ' ' + h.Soyad AS HastaAdi,
             r.SicilNo, d.Ad + ' ' + d.Soyad AS DoktorAdi, 
             p.PAdi AS Poliklinik
      FROM Randevu r
      JOIN Hasta h ON r.TC = h.TC
      JOIN Doktor d ON r.SicilNo = d.SicilNo
      JOIN Poliklinik p ON r.PID = p.PID
      ORDER BY r.R_Tarih DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Randevu listeleme hatası:', {
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ 
      error: 'Randevular getirilemedi',
      details: err.message
    });
  }
});

// Veritabanı bağlantı test endpoint'i
app.get('/api/checkdb', async (req, res) => {
  try {
    const request = pool.request();
    const result = await request.query('SELECT TOP 1 * FROM Doktor');
    res.json({ 
      status: 'connected',
      sampleDoctor: result.recordset[0] || 'Kayıt bulunamadı'
    });
  } catch (err) {
    console.error('Veritabanı kontrol hatası:', {
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ 
      status: 'disconnected',
      error: err.message,
      details: err.originalError?.info?.message
    });
  }
});

// Sunucuyu başlat
const PORT = 5500;
app.listen(PORT, () => {
  console.log(`🚀 Sunucu http://localhost:${PORT} üzerinde çalışıyor`);
  console.log(`Test endpointi: http://localhost:${PORT}/api/test`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  try {
    if (pool) {
      await pool.close();
      console.log('✅ Veritabanı bağlantıları kapatıldı');
    }
  } catch (err) {
    console.error('Bağlantı kapatma hatası:', err.message);
  }
  process.exit(0);
});