-- VARSA VERİTABANINI SİL
USE master;
GO

IF EXISTS (SELECT name FROM sys.databases WHERE name = 'Hastane')
BEGIN
    ALTER DATABASE Hastane SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE Hastane;
END
GO

-- VERİTABANI OLUŞTUR
CREATE DATABASE Hastane;
GO

-- VERİTABANINI KULLAN
USE Hastane;
GO

-- Adres Tablosu (Önce oluşturulmalı çünkü diğer tablolar buna referans veriyor)
CREATE TABLE Adres (
    Adres_ID INT PRIMARY KEY IDENTITY(1,1),
    Sehir VARCHAR(50),
    Ilce VARCHAR(50),
    Cadde VARCHAR(50),
    Sokak VARCHAR(50),
    ANo VARCHAR(10)
);
GO

-- Hastane Tablosu
CREATE TABLE Hastane (
    HastaneID INT PRIMARY KEY,
    TelNo VARCHAR(15),
    HAdi VARCHAR(100),
    Adres_ID INT,
    FOREIGN KEY (Adres_ID) REFERENCES Adres(Adres_ID)
);
GO

-- Poliklinik Tablosu
CREATE TABLE Poliklinik (
    PID INT PRIMARY KEY,
    PAdi VARCHAR(100)
);
GO

-- Hastane_Poliklinik İlişki Tablosu
CREATE TABLE Hastane_Poliklinik (
    HastaneID INT,
    PID INT,
    PRIMARY KEY (HastaneID, PID),
    FOREIGN KEY (HastaneID) REFERENCES Hastane(HastaneID),
    FOREIGN KEY (PID) REFERENCES Poliklinik(PID)
);
GO

-- Doktor Tablosu
CREATE TABLE Doktor (
    SicilNo INT PRIMARY KEY,
    Ad VARCHAR(50),
    Soyad VARCHAR(50)
);
GO

-- Branş Tablosu
CREATE TABLE Brans (
    SicilNo INT PRIMARY KEY,
    Brans VARCHAR(50),
    FOREIGN KEY (SicilNo) REFERENCES Doktor(SicilNo)
);
GO

-- Hastane_Poliklinik_Doktor İlişki Tablosu
CREATE TABLE Hastane_Poliklinik_Doktor (
    HastaneID INT,
    PID INT,
    SicilNo INT,
    PRIMARY KEY (HastaneID, PID, SicilNo),
    FOREIGN KEY (HastaneID) REFERENCES Hastane(HastaneID),
    FOREIGN KEY (PID) REFERENCES Poliklinik(PID),
    FOREIGN KEY (SicilNo) REFERENCES Doktor(SicilNo)
);
GO

-- Hasta Tablosu
CREATE TABLE Hasta (
    TC CHAR(11) PRIMARY KEY,
    Ad VARCHAR(50),
    Soyad VARCHAR(50),
    Cinsiyet CHAR(1),
    DogumTarihi DATE
);
GO

-- Hasta_TEL Tablosu
CREATE TABLE Hasta_TEL (
    TC CHAR(11),
    Tel_No VARCHAR(15),
    PRIMARY KEY (TC, Tel_No),
    FOREIGN KEY (TC) REFERENCES Hasta(TC)
);
GO

-- Randevu Tablosu
CREATE TABLE Randevu (
    RID INT PRIMARY KEY,
    R_Tarih DATETIME,
    TC CHAR(11),
    SicilNo INT,
    PID INT,
    FOREIGN KEY (TC) REFERENCES Hasta(TC),
    FOREIGN KEY (SicilNo) REFERENCES Doktor(SicilNo),
    FOREIGN KEY (PID) REFERENCES Poliklinik(PID)
);
GO

-- Ceza Tablosu
CREATE TABLE Ceza (
    RID INT PRIMARY KEY,
    Baslangic_Tarihi DATE,
    Bitis_Tarihi DATE,
    FOREIGN KEY (RID) REFERENCES Randevu(RID)
);
GO

-- Hasta Bazlı Randevu bilgilerini Getirme Stored Procedure
CREATE PROCEDURE GetAllRandevuBilgileri
    @TC CHAR(11)
AS
BEGIN
    SELECT 
        R.RID, 
        R.R_Tarih, 
        D.Ad AS DoctorName,
        P.PAdi AS PoliklinikAdi
    FROM Randevu R
    JOIN Doktor D ON R.SicilNo = D.SicilNo
    JOIN Poliklinik P ON R.PID = P.PID
    WHERE R.TC = @TC;
END;
GO

-- Randevu Kuralları Trigger'ı
CREATE OR ALTER TRIGGER trg_RandevuKurallari
ON Randevu
INSTEAD OF INSERT
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        -- 1. Randevu saat kontrolü (07:00-17:00 arası ve :00 veya :30 dakikalarında)
        IF EXISTS (
            SELECT 1
            FROM inserted
            WHERE 
                DATEPART(HOUR, R_Tarih) < 7 OR 
                DATEPART(HOUR, R_Tarih) > 17 OR
                DATEPART(MINUTE, R_Tarih) NOT IN (0, 30)
        )
        BEGIN
            RAISERROR('Randevular 07:00-17:00 arasında ve 00 veya 30 dakikalarında olmalıdır.', 16, 1);
            ROLLBACK TRANSACTION;
            RETURN;
        END

        -- 2. Aynı hasta için aynı saatte çakışan randevu kontrolü
        IF EXISTS (
            SELECT 1
            FROM inserted i
            JOIN Randevu r ON i.TC = r.TC AND i.R_Tarih = r.R_Tarih
        )
        BEGIN
            RAISERROR('Bu hasta için zaten bu saatte bir randevu bulunmaktadır.', 16, 1);
            ROLLBACK TRANSACTION;
            RETURN;
        END

        -- 3. Doktorun aynı poliklinikte aynı saatte müsaitlik kontrolü
        IF EXISTS (
            SELECT 1
            FROM inserted i
            JOIN Randevu r 
              ON i.SicilNo = r.SicilNo 
             AND i.PID = r.PID 
             AND i.R_Tarih = r.R_Tarih
        )
        BEGIN
            RAISERROR('Doktorun bu poliklinikte bu saatte zaten bir randevusu var.', 16, 1);
            ROLLBACK TRANSACTION;
            RETURN;
        END

        -- 4. Geçmiş tarihli randevu kontrolü
        IF EXISTS (
            SELECT 1
            FROM inserted
            WHERE R_Tarih < GETDATE()
        )
        BEGIN
            RAISERROR('Geçmiş tarihe randevu oluşturulamaz.', 16, 1);
            ROLLBACK TRANSACTION;
            RETURN;
        END

        -- 5. 1.5 yıldan fazla ileri tarih kontrolü
        IF EXISTS (
            SELECT 1
            FROM inserted
            WHERE R_Tarih > DATEADD(MONTH, 18, GETDATE())
        )
        BEGIN
            RAISERROR('Randevular en fazla 1.5 yıl sonrasına oluşturulabilir.', 16, 1);
            ROLLBACK TRANSACTION;
            RETURN;
        END

        -- Ekleme işlemi
        INSERT INTO Randevu (RID, R_Tarih, TC, SicilNo, PID)
        SELECT RID, R_Tarih, TC, SicilNo, PID
        FROM inserted;

        COMMIT TRANSACTION;
    END TRY
    BEGIN CATCH
        IF @@TRANCOUNT > 0
            ROLLBACK TRANSACTION;

        DECLARE @HataMesaji NVARCHAR(4000) = ERROR_MESSAGE();
        DECLARE @HataSeverity INT = ERROR_SEVERITY();
        DECLARE @HataState INT = ERROR_STATE();
        
        RAISERROR(@HataMesaji, @HataSeverity, @HataState);
    END CATCH
END;
GO


-- ÖRNEK VERİLERİ EKLEME

-- Adres ekle
INSERT INTO Adres (Sehir, Ilce, Cadde, Sokak, ANo) VALUES 
('İstanbul', 'Beşiktaş', 'Bağdat Cad.', 'Çınar Sok.', '15'),
('Ankara', 'Çankaya', 'Atatürk Bulv.', 'Çiçek Sok.', '10'),
('İzmir', 'Bornova', 'Cumhuriyet Cd.', 'Gül Sok.', '22'),
('Bursa', 'Nilüfer', 'İstiklal Cd.', 'Lale Sok.', '5');
GO

-- Hastane ekle
INSERT INTO Hastane VALUES 
(1, '02123456789', 'Özel Sağlık Hastanesi', 1),
(2, '02123334455', 'Şehir Hastanesi', 2),
(3, '02462223344', 'Ege Tıp Merkezi', 3),
(4, '03262221100', 'Nilüfer Hastanesi', 4);
GO

-- Poliklinik ekle
INSERT INTO Poliklinik VALUES 
(101, 'Kardiyoloji'),
(201, 'Ortopedi'),
(202, 'Çocuk Cerrahisi'),
(203, 'Kadın Doğum'),
(204, 'Göz Hastalıkları');
GO

-- Hastane_Poliklinik ilişkileri
INSERT INTO Hastane_Poliklinik VALUES
(1, 101),
(2, 201),
(2, 202),
(3, 203),
(4, 204);
GO

-- Doktor ekle
INSERT INTO Doktor VALUES 
(5001, 'Sıla', 'Kasalı'),
(6001, 'Mehmet', 'Demir'),
(6002, 'Ayşe', 'Kara'),
(7001, 'Elif', 'Yılmaz'),
(8001, 'Mustafa', 'Çelik');
GO

-- Branş ekle
INSERT INTO Brans VALUES
(5001, 'Kalp Hastalıkları'),
(6001, 'Ortopedi'),
(6002, 'Çocuk Cerrahisi'),
(7001, 'Kadın Doğum'),
(8001, 'Göz Hastalıkları');
GO

-- Hastane_Poliklinik_Doktor ilişkileri
INSERT INTO Hastane_Poliklinik_Doktor VALUES
(1, 101, 5001),
(2, 201, 6001),
(2, 202, 6002),
(3, 203, 7001),
(4, 204, 8001);
GO

-- Hasta ekle
INSERT INTO Hasta VALUES 
('12345678901', 'Ahmet', 'Yılmaz', 'E', '1990-05-15'),
('11122233344', 'Ali', 'Vural', 'E', '1995-08-22'),
('22233344455', 'Fatma', 'Öztürk', 'K', '1983-03-10'),
('33344455566', 'Burak', 'Aslan', 'E', '1989-11-28'),
('44455566677', 'Gamze', 'Polat', 'K', '1974-07-03');
GO

-- Hasta telefon numaraları
INSERT INTO Hasta_TEL VALUES
('12345678901', '05551234567'),
('11122233344', '05335557788'),
('22233344455', '05448811223'),
('33344455566', '05552223344'),
('44455566677', '05001112233');
GO

-- Randevu ekle
INSERT INTO Randevu VALUES 
(10001, '2025-05-25 14:30:00', '12345678901', 5001, 101),
(20001, '2025-05-26 09:00:00', '11122233344', 6001, 201),
(20002, '2025-05-27 09:30:00', '22233344455', 6002, 202),
(20003, '2025-05-28 10:00:00', '33344455566', 7001, 203),
(20004, '2025-05-29 11:30:00', '44455566677', 8001, 204);
GO

-- Ceza ekle
INSERT INTO Ceza VALUES 
(20002, '2025-05-10', DATEADD(DAY, 15, '2025-05-10')),
(20004, '2025-05-12', DATEADD(DAY, 15, '2025-05-12'));
GO

-- Stored Procedure'ü test etme
EXEC GetAllRandevuBilgileri @TC = '12345678901';
GO
-- Hasta tablosunu göster
SELECT * FROM Hasta;

-- Doktor tablosunu göster
SELECT * FROM Doktor;

-- Klinik tablosunu göster
SELECT * FROM Poliklinik;

-- Randevu tablosunu göster
SELECT * FROM Randevu;

-- Ceza tablosunu göster
SELECT * FROM Ceza;

SELECT * FROM Hasta WHERE TC = '10000000000';
SELECT * FROM Randevu WHERE TC = '10000000000';
EXEC GetAllRandevuBilgileri @TC = '10000000000';
SELECT * FROM Hasta WHERE Ad = 'berat kaçar';
