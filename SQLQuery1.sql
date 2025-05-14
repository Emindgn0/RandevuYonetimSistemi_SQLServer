-- VARSA VER�TABANINI S�L
USE master;
GO

IF EXISTS (SELECT name FROM sys.databases WHERE name = 'Hastane')
BEGIN
    ALTER DATABASE Hastane SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
    DROP DATABASE Hastane;
END
GO

-- VER�TABANI OLU�TUR
CREATE DATABASE Hastane;
GO

-- VER�TABANINI KULLAN
USE Hastane;
GO

-- Adres Tablosu (�nce olu�turulmal� ��nk� di�er tablolar buna referans veriyor)
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

-- Hastane_Poliklinik �li�ki Tablosu
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

-- Bran� Tablosu
CREATE TABLE Brans (
    SicilNo INT PRIMARY KEY,
    Brans VARCHAR(50),
    FOREIGN KEY (SicilNo) REFERENCES Doktor(SicilNo)
);
GO

-- Hastane_Poliklinik_Doktor �li�ki Tablosu
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

-- Hasta Bazl� Randevu bilgilerini Getirme Stored Procedure
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

-- Randevu Kurallar� Trigger'�
CREATE OR ALTER TRIGGER trg_RandevuKurallari
ON Randevu
INSTEAD OF INSERT
AS
BEGIN
    SET NOCOUNT ON;

    BEGIN TRY
        BEGIN TRANSACTION;

        -- 1. Randevu saat kontrol� (07:00-17:00 aras� ve :00 veya :30 dakikalar�nda)
        IF EXISTS (
            SELECT 1
            FROM inserted
            WHERE 
                DATEPART(HOUR, R_Tarih) < 7 OR 
                DATEPART(HOUR, R_Tarih) > 17 OR
                DATEPART(MINUTE, R_Tarih) NOT IN (0, 30)
        )
        BEGIN
            RAISERROR('Randevular 07:00-17:00 aras�nda ve 00 veya 30 dakikalar�nda olmal�d�r.', 16, 1);
            ROLLBACK TRANSACTION;
            RETURN;
        END

        -- 2. Ayn� hasta i�in ayn� saatte �ak��an randevu kontrol�
        IF EXISTS (
            SELECT 1
            FROM inserted i
            JOIN Randevu r ON i.TC = r.TC AND i.R_Tarih = r.R_Tarih
        )
        BEGIN
            RAISERROR('Bu hasta i�in zaten bu saatte bir randevu bulunmaktad�r.', 16, 1);
            ROLLBACK TRANSACTION;
            RETURN;
        END

        -- 3. Doktorun ayn� poliklinikte ayn� saatte m�saitlik kontrol�
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

        -- 4. Ge�mi� tarihli randevu kontrol�
        IF EXISTS (
            SELECT 1
            FROM inserted
            WHERE R_Tarih < GETDATE()
        )
        BEGIN
            RAISERROR('Ge�mi� tarihe randevu olu�turulamaz.', 16, 1);
            ROLLBACK TRANSACTION;
            RETURN;
        END

        -- 5. 1.5 y�ldan fazla ileri tarih kontrol�
        IF EXISTS (
            SELECT 1
            FROM inserted
            WHERE R_Tarih > DATEADD(MONTH, 18, GETDATE())
        )
        BEGIN
            RAISERROR('Randevular en fazla 1.5 y�l sonras�na olu�turulabilir.', 16, 1);
            ROLLBACK TRANSACTION;
            RETURN;
        END

        -- Ekleme i�lemi
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


-- �RNEK VER�LER� EKLEME

-- Adres ekle
INSERT INTO Adres (Sehir, Ilce, Cadde, Sokak, ANo) VALUES 
('�stanbul', 'Be�ikta�', 'Ba�dat Cad.', '��nar Sok.', '15'),
('Ankara', '�ankaya', 'Atat�rk Bulv.', '�i�ek Sok.', '10'),
('�zmir', 'Bornova', 'Cumhuriyet Cd.', 'G�l Sok.', '22'),
('Bursa', 'Nil�fer', '�stiklal Cd.', 'Lale Sok.', '5');
GO

-- Hastane ekle
INSERT INTO Hastane VALUES 
(1, '02123456789', '�zel Sa�l�k Hastanesi', 1),
(2, '02123334455', '�ehir Hastanesi', 2),
(3, '02462223344', 'Ege T�p Merkezi', 3),
(4, '03262221100', 'Nil�fer Hastanesi', 4);
GO

-- Poliklinik ekle
INSERT INTO Poliklinik VALUES 
(101, 'Kardiyoloji'),
(201, 'Ortopedi'),
(202, '�ocuk Cerrahisi'),
(203, 'Kad�n Do�um'),
(204, 'G�z Hastal�klar�');
GO

-- Hastane_Poliklinik ili�kileri
INSERT INTO Hastane_Poliklinik VALUES
(1, 101),
(2, 201),
(2, 202),
(3, 203),
(4, 204);
GO

-- Doktor ekle
INSERT INTO Doktor VALUES 
(5001, 'S�la', 'Kasal�'),
(6001, 'Mehmet', 'Demir'),
(6002, 'Ay�e', 'Kara'),
(7001, 'Elif', 'Y�lmaz'),
(8001, 'Mustafa', '�elik');
GO

-- Bran� ekle
INSERT INTO Brans VALUES
(5001, 'Kalp Hastal�klar�'),
(6001, 'Ortopedi'),
(6002, '�ocuk Cerrahisi'),
(7001, 'Kad�n Do�um'),
(8001, 'G�z Hastal�klar�');
GO

-- Hastane_Poliklinik_Doktor ili�kileri
INSERT INTO Hastane_Poliklinik_Doktor VALUES
(1, 101, 5001),
(2, 201, 6001),
(2, 202, 6002),
(3, 203, 7001),
(4, 204, 8001);
GO

-- Hasta ekle
INSERT INTO Hasta VALUES 
('12345678901', 'Ahmet', 'Y�lmaz', 'E', '1990-05-15'),
('11122233344', 'Ali', 'Vural', 'E', '1995-08-22'),
('22233344455', 'Fatma', '�zt�rk', 'K', '1983-03-10'),
('33344455566', 'Burak', 'Aslan', 'E', '1989-11-28'),
('44455566677', 'Gamze', 'Polat', 'K', '1974-07-03');
GO

-- Hasta telefon numaralar�
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

-- Stored Procedure'� test etme
EXEC GetAllRandevuBilgileri @TC = '12345678901';
GO
-- Hasta tablosunu g�ster
SELECT * FROM Hasta;

-- Doktor tablosunu g�ster
SELECT * FROM Doktor;

-- Klinik tablosunu g�ster
SELECT * FROM Poliklinik;

-- Randevu tablosunu g�ster
SELECT * FROM Randevu;

-- Ceza tablosunu g�ster
SELECT * FROM Ceza;

SELECT * FROM Hasta WHERE TC = '10000000000';
SELECT * FROM Randevu WHERE TC = '10000000000';
EXEC GetAllRandevuBilgileri @TC = '10000000000';
SELECT * FROM Hasta WHERE Ad = 'berat ka�ar';
