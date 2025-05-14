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
  }
};

// Bağlantı havuzu
const pool = new sql.ConnectionPool(dbConfig);
pool.connect()
  .then(() => console.log('✅ SQL Server bağlantısı başarılı'))
  .catch(err => {
    console.error('❌ SQL Server bağlantı hatası:', err);
    console.error('Hata detayı:', err.originalError?.info?.message || err.message);
  });

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
    const result = await pool.request().query(`
      SELECT h.HastaneID, h.HAdi, h.TelNo, 
             a.Sehir, a.Ilce, a.Cadde, a.Sokak, a.ANo
      FROM Hastane h
      JOIN Adres a ON h.Adres_ID = a.Adres_ID
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Hastaneler yükleme hatası:', err.message, err.stack);
    res.status(500).json({ error: 'Hastaneler yüklenemedi', details: err.message });
  }
});

// Poliklinik listesi endpoint'i
app.get('/api/poliklinikler', async (req, res) => {
  const hastaneIdRaw = req.query.hastane;

  // Sayıya çevir ve geçerliliğini kontrol et
  const hastaneId = parseInt(hastaneIdRaw, 10);
  if (isNaN(hastaneId)) {
    return res.status(400).json({ 
      error: 'Geçersiz hastane ID. Örnek kullanım: /api/poliklinikler?hastane=1'
    });
  }

  try {
    // 1. Hastane varlık kontrolü
    const hastaneKontrol = await pool.request()
      .input('HastaneID', sql.Int, hastaneId)
      .query('SELECT HAdi FROM Hastane WHERE HastaneID = @HastaneID');
    
    if (hastaneKontrol.recordset.length === 0) {
      return res.status(404).json({ error: 'Hastane bulunamadı' });
    }

    // 2. Poliklinikleri getir
    const result = await pool.request()
      .input('HastaneID', sql.Int, hastaneId)
      .query(`
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
    console.error('Poliklinik sorgu hatası:', err);
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
    let request = pool.request();
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
      request.input('hastaneId', sql.Int, hastaneId);
      request.input('poliklinikId', sql.Int, poliklinikId);
    }

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    handleError(res, err, 'Doktorlar yüklenemedi');
  }
});

// Randevu listesi endpoint'i
app.post('/api/randevu', async (req, res) => {
  const { tc, doktorId, tarih } = req.body;

  // Gerekli alanların kontrolü
  if (!tc || !doktorId || !tarih) {
    console.error('Eksik alanlar:', { tc, doktorId, tarih });
    return res.status(400).json({ error: 'TC, doktor ID ve tarih gereklidir' });
  }

  // Veri format kontrolü
  if (!/^\d{11}$/.test(tc)) {
    console.error('Geçersiz TC:', tc);
    return res.status(400).json({ error: 'TC Kimlik No 11 haneli olmalıdır' });
  }
  const parsedDoktorId = parseInt(doktorId, 10);
  if (isNaN(parsedDoktorId)) {
    console.error('Geçersiz doktorId:', doktorId);
    return res.status(400).json({ error: 'Doktor ID geçerli bir tamsayı olmalıdır' });
  }
  const randevuTarihi = new Date(tarih);
  if (isNaN(randevuTarihi.getTime())) {
    console.error('Geçersiz tarih:', tarih);
    return res.status(400).json({ error: 'Geçersiz tarih formatı (ör: 2025-05-14T08:30:00.000Z)' });
  }

  let transaction;
  try {
    // Transaction başlat
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const request = new sql.Request(transaction);

    // Parametreleri tanımla
    request.input('TC', sql.Char(11), tc);
    request.input('SicilNo', sql.Int, parsedDoktorId);
    request.input('R_Tarih', sql.DateTime, randevuTarihi);

    // Hasta varlığını kontrol et
    console.log('Hasta kontrol ediliyor:', { TC: tc });
    const hastaKontrol = await request.query('SELECT 1 FROM Hasta WHERE TC = @TC');
    if (hastaKontrol.recordset.length === 0) {
      throw new Error(`Hasta bulunamadı (TC: ${tc})`);
    }

    // Doktor ve poliklinik varlığını kontrol et
    console.log('Doktor kontrol ediliyor:', { SicilNo: parsedDoktorId });
    const doktorKontrol = await request.query(`
      SELECT hpd.PID 
      FROM Hastane_Poliklinik_Doktor hpd 
      WHERE hpd.SicilNo = @SicilNo
    `);
    if (doktorKontrol.recordset.length === 0) {
      throw new Error(`Doktor (SicilNo: ${parsedDoktorId}) veya poliklinik bulunamadı`);
    }
    const PID = doktorKontrol.recordset[0].PID;
    console.log('Poliklinik bulundu:', { PID });

    // Yeni RID oluştur
    console.log('Yeni RID oluşturuluyor...');
    const lastId = await request.query('SELECT ISNULL(MAX(RID), 0) + 1 AS newRID FROM Randevu');
    const newRID = lastId.recordset[0].newRID;
    console.log('Yeni RID:', newRID);

    // Randevuyu ekle
    console.log('Randevu ekleniyor:', { RID: newRID, TC: tc, SicilNo: parsedDoktorId, R_Tarih: randevuTarihi, PID });
    await request
      .input('RID', sql.Int, newRID)
      .input('PID', sql.Int, PID)
      .query(`
        INSERT INTO Randevu (RID, R_Tarih, TC, SicilNo, PID)
        VALUES (@RID, @R_Tarih, @TC, @SicilNo, @PID)
      `);

    // Transaction'ı tamamla
    await transaction.commit();
    console.log('Randevu başarıyla oluşturuldu:', newRID);
    res.status(201).json({ 
      success: true,
      randevuId: newRID,
      message: 'Randevu başarıyla oluşturuldu'
    });
  } catch (err) {
    // Hata durumunda transaction'ı geri al
    if (transaction) {
      console.log('Transaction geri alınıyor...');
      await transaction.rollback();
    }
    console.error('Randevu oluşturma hatası:', err.message, err.stack);
    // Trigger hatalarını ayrıştır
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
// Müsait saatler endpoint'i
app.get('/api/musait-saatler', async (req, res) => {
  const { doktorId, tarih } = req.query;

  if (!doktorId || !tarih) {
    return res.status(400).json({ error: 'Doktor ID ve tarih gereklidir' });
  }

  try {
    // Mevcut randevuları al
    const randevular = await pool.request()
      .input('doktorId', sql.Int, doktorId)
      .input('tarih', sql.Date, tarih)
      .query(`
        SELECT CONVERT(TIME, R_Tarih) AS saat 
        FROM Randevu 
        WHERE SicilNo = @doktorId 
        AND CONVERT(DATE, R_Tarih) = @tarih
      `);

    // Tüm olası saatleri oluştur (07:00-17:00 arası, 30 dakika aralıklarla)
    const tumSaatler = [];
    for (let hour = 7; hour < 17; hour++) {
      tumSaatler.push(`${hour.toString().padStart(2, '0')}:00`);
      tumSaatler.push(`${hour.toString().padStart(2, '0')}:30`);
    }
    tumSaatler.push('17:00');

    // Dolu saatleri filtrele
    const doluSaatler = randevular.recordset.map(r => r.saat.substring(0, 5));
    const musaitSaatler = tumSaatler.filter(saat => !doluSaatler.includes(saat));

    res.json(musaitSaatler.map(saat => ({
      time: saat,
      available: !doluSaatler.includes(saat)
    })));
  } catch (err) {
    handleError(res, err, 'Müsait saatler yüklenemedi');
  }
});

// Hasta oluşturma endpoint'i
app.post('/api/hasta', async (req, res) => {
  const { TC, Ad, Soyad, Cinsiyet, DogumTarihi, TelNo } = req.body;
  if (!TC || !Ad || !Soyad || !Cinsiyet || !DogumTarihi || !TelNo) {
    return res.status(400).json({ error: 'Tüm alanlar zorunludur' });
  }
  if (!/^\d{11}$/.test(TC)) {
    return res.status(400).json({ error: 'TC Kimlik No 11 haneli olmalıdır' });
  }
  if (!/^\d{10}$/.test(TelNo)) {
    return res.status(400).json({ error: 'Telefon numarası 10 haneli olmalıdır' });
  }
  if (!['E', 'K'].includes(Cinsiyet)) {
    return res.status(400).json({ error: 'Cinsiyet "E" veya "K" olmalıdır' });
  }
  const dogumTarihiDate = new Date(DogumTarihi);
  if (isNaN(dogumTarihiDate.getTime())) {
    return res.status(400).json({ error: 'Geçersiz doğum tarihi formatı' });
  }

  let transaction;
  try {
    transaction = new sql.Transaction(pool);
    await transaction.begin();
    const request = new sql.Request(transaction);
    await request
      .input('TC', sql.Char(11), TC)
      .input('Ad', sql.VarChar(50), Ad)
      .input('Soyad', sql.VarChar(50), Soyad)
      .input('Cinsiyet', sql.Char(1), Cinsiyet)
      .input('DogumTarihi', sql.Date, dogumTarihiDate)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM Hasta WHERE TC = @TC)
          INSERT INTO Hasta (TC, Ad, Soyad, Cinsiyet, DogumTarihi)
          VALUES (@TC, @Ad, @Soyad, @Cinsiyet, @DogumTarihi)
        ELSE
          UPDATE Hasta
          SET Ad = @Ad, Soyad = @Soyad, Cinsiyet = @Cinsiyet, DogumTarihi = @DogumTarihi
          WHERE TC = @TC
      `);
    await request
      .input('TelNo', sql.VarChar(15), TelNo)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM Hasta_TEL WHERE TC = @TC AND Tel_No = @TelNo)
          INSERT INTO Hasta_TEL (TC, Tel_No)
          VALUES (@TC, @TelNo)
      `);
    await transaction.commit();
    res.status(201).json({ success: true, message: 'Hasta bilgileri başarıyla kaydedildi' });
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error('Hasta kaydetme hatası:', err.message);
    res.status(500).json({ error: 'Hasta kaydedilemedi', details: err.message });
  }
});

app.post('/api/hasta', async (req, res) => {
  const { TC, Ad, Soyad, Cinsiyet, DogumTarihi, TelNo } = req.body;

  // Gerekli alanların kontrolü
  if (!TC || !Ad || !Soyad || !Cinsiyet || !DogumTarihi || !TelNo) {
    console.error('Eksik alanlar:', { TC, Ad, Soyad, Cinsiyet, DogumTarihi, TelNo });
    return res.status(400).json({ error: 'Tüm alanlar zorunludur: TC, Ad, Soyad, Cinsiyet, DogumTarihi, TelNo' });
  }

  // TC ve TelNo format kontrolü
  if (!/^\d{11}$/.test(TC)) {
    console.error('Geçersiz TC:', TC);
    return res.status(400).json({ error: 'TC Kimlik No 11 haneli olmalıdır' });
  }
  if (!/^\d{10}$/.test(TelNo)) {
    console.error('Geçersiz TelNo:', TelNo);
    return res.status(400).json({ error: 'Telefon numarası 10 haneli olmalıdır (ör: 5551234567)' });
  }

  // Cinsiyet kontrolü
  if (!['E', 'K'].includes(Cinsiyet)) {
    console.error('Geçersiz Cinsiyet:', Cinsiyet);
    return res.status(400).json({ error: 'Cinsiyet "E" veya "K" olmalıdır' });
  }

  // DogumTarihi format kontrolü
  const dogumTarihiDate = new Date(DogumTarihi);
  if (isNaN(dogumTarihiDate.getTime())) {
    console.error('Geçersiz DogumTarihi:', DogumTarihi);
    return res.status(400).json({ error: 'Geçersiz doğum tarihi formatı (ör: 2000-01-01)' });
  }

  let transaction;
  try {
    // Transaction başlat
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const request = new sql.Request(transaction);

    // Hasta ekle veya güncelle
    console.log('Hasta ekleme/güncelleme:', { TC, Ad, Soyad, Cinsiyet, DogumTarihi });
    await request
      .input('TC', sql.Char(11), TC)
      .input('Ad', sql.VarChar(50), Ad)
      .input('Soyad', sql.VarChar(50), Soyad)
      .input('Cinsiyet', sql.Char(1), Cinsiyet)
      .input('DogumTarihi', sql.Date, dogumTarihiDate)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM Hasta WHERE TC = @TC)
          INSERT INTO Hasta (TC, Ad, Soyad, Cinsiyet, DogumTarihi)
          VALUES (@TC, @Ad, @Soyad, @Cinsiyet, @DogumTarihi)
        ELSE
          UPDATE Hasta
          SET Ad = @Ad, Soyad = @Soyad, Cinsiyet = @Cinsiyet, DogumTarihi = @DogumTarihi
          WHERE TC = @TC
      `);

    // Telefon ekle (tekrar eklenmesini önle)
    console.log('Telefon ekleme:', { TC, TelNo });
    await request
      .input('TelNo', sql.VarChar(15), TelNo)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM Hasta_TEL WHERE TC = @TC AND Tel_No = @TelNo)
          INSERT INTO Hasta_TEL (TC, Tel_No)
          VALUES (@TC, @TelNo)
      `);

    // Transaction'ı tamamla
    await transaction.commit();
    console.log('Hasta başarıyla kaydedildi:', TC);
    res.status(201).json({ success: true, message: 'Hasta bilgileri başarıyla kaydedildi' });
  } catch (err) {
    // Hata durumunda transaction'ı geri al
    if (transaction) await transaction.rollback();
    console.error('Hasta kaydetme hatası:', err.message, err.stack);
    res.status(500).json({ 
      error: 'Hasta kaydedilemedi',
      details: err.message
    });
  }
});

// Randevu listeleme endpoint'i
app.get('/api/randevu', async (req, res) => {
  try {
    const result = await pool.request().query(`
      SELECT r.RID, FORMAT(r.R_Tarih, 'yyyy-MM-dd HH:mm') AS Tarih, 
             r.TC, h.Ad + ' ' + h.Soyad AS HastaAdi,
             r.SicilNo, d.Ad + ' ' + d.Soyad AS DoktorAdi, 
             p.PAdi AS Poliklinik, r.GeldiMi
      FROM Randevu r
      JOIN Hasta h ON r.TC = h.TC
      JOIN Doktor d ON r.SicilNo = d.SicilNo
      JOIN Poliklinik p ON r.PID = p.PID
      ORDER BY r.R_Tarih DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Hata:', err);
    res.status(500).json({ 
      message: 'Randevular getirilemedi',
      error: err.message
    });
  }
});

// Veritabanı bağlantı test endpoint'i
app.get('/api/checkdb', async (req, res) => {
  try {
    const result = await pool.request().query('SELECT TOP 1 * FROM Doktor');
    res.json({ 
      status: 'connected',
      sampleDoctor: result.recordset[0] || 'Kayıt bulunamadı'
    });
  } catch (err) {
    res.status(500).json({ 
      status: 'disconnected',
      error: err.message,
      details: err.originalError?.info?.message
    });
  }
});

// Hata yönetim fonksiyonu
function handleError(res, err, message) {
  console.error('Hata:', err);
  res.status(500).json({ 
    error: message,
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
}

// Sunucuyu başlat
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Sunucu http://localhost:${PORT} üzerinde çalışıyor`);
  console.log(`Test endpointi: http://localhost:${PORT}/api/test`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await pool.close();
  console.log('Bağlantılar kapatıldı');
  process.exit(0);
});