const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'camp_manager.db');

// Optional: Delete existing database to start fresh with new schema
if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    console.log("Old database deleted for fresh start.");
}

const db = new Database(dbPath);

// Enable Foreign Keys
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  -- 1. Counselors (Home Group Leaders)
  CREATE TABLE IF NOT EXISTS Counselors (
    CounselorID INTEGER PRIMARY KEY AUTOINCREMENT,
    FirstName TEXT NOT NULL,
    LastName TEXT NOT NULL,
    -- Fixed typo constraint
    HomeGroupColor TEXT CHECK(HomeGroupColor IN ('Red', 'Carolina', 'Green', 'Navy')),
    ScheduleType TEXT
  );

  -- 2. Staff (Unit Leaders & Instructors)
  CREATE TABLE IF NOT EXISTS Staff (
    StaffID INTEGER PRIMARY KEY AUTOINCREMENT,
    FirstName TEXT NOT NULL,
    LastName TEXT NOT NULL,
    StaffType TEXT CHECK(StaffType IN ('Unit Leader', 'Instructor')),
    ColorGroup TEXT -- NULL for Instructors, assigned for Unit Leaders
  );

  -- 3. Campers
  CREATE TABLE IF NOT EXISTS Campers (
    CamperID INTEGER PRIMARY KEY AUTOINCREMENT,
    FirstName TEXT NOT NULL,
    LastName TEXT NOT NULL,
    Age INTEGER,
    -- Fixed typo constraint
    ColorGroup TEXT CHECK(ColorGroup IN ('Red', 'Carolina', 'Green', 'Navy')),
    HomeGroupCounselorID INTEGER,
    BusRoute INTEGER,
    ExtendedHours TEXT CHECK(ExtendedHours IN ('AM', 'PM', 'Both', NULL)),
    CampLunch TEXT CHECK(CampLunch IN ('Yes', 'No', 'Allergy')),
    FOREIGN KEY (HomeGroupCounselorID) REFERENCES Counselors(CounselorID)
  );

  -- 4. Unified Schedules Table
  CREATE TABLE IF NOT EXISTS Schedules (
    ScheduleID INTEGER PRIMARY KEY AUTOINCREMENT,
    PersonID INTEGER,
    PersonType TEXT CHECK(PersonType IN ('Camper', 'Counselor', 'Staff')),
    PeriodNumber INTEGER,
    ActivityName TEXT,
    Location TEXT,
    TimeOfDay TEXT CHECK(TimeOfDay IN ('AM', 'PM'))
  );
CREATE TABLE IF NOT EXISTS Activities (
    ActivityID INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT UNIQUE NOT NULL,
    SideOfCamp TEXT CHECK(SideOfCamp IN ('Sports', 'Enrichment')),
    MaxCapacity INTEGER DEFAULT 20
  );
  CREATE TABLE IF NOT EXISTS Waitlists (
    WaitlistID INTEGER PRIMARY KEY AUTOINCREMENT,
    CamperID INTEGER,
    PeriodNumber INTEGER,
    RequestedActivity TEXT,
    TimeOfDay TEXT,
    Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (CamperID) REFERENCES Campers(CamperID)
  );
`);

console.log("Database initialized successfully!");

db.close();