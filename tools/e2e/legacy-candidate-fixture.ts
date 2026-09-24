import assert from "node:assert/strict";
import { runLocal } from "./legacy-organization-rehearsal-runtime";

export const candidateAsOf = "2026-09-24T12:00:00Z";

export const candidateWatermark = "synthetic-candidate-2026-09-24";

export const candidateSnapshotId = "synthetic-combined-candidate-2026";

export const candidateAccount = "8601.11.17947";

export const candidatePdf = Buffer.from("%PDF-1.4\nsynthetic combined candidate receipt\n%%EOF\n");

const identity = (id: number) => ({
  personId: `legacy-person-${id}`,
  email: `candidate${id}@example.invalid`,
  password: `Candidate-local-${id}-2026!`,
  firstName: `CandidateGiven${id}`,
  lastName: `CandidateFamily${id}`,
});

export const candidateIdentities = {
  leader: identity(1),
  member: identity(2),
  historicalLeader: identity(3),
  otherDepartment: identity(4),
};

export const candidateScope = {
  departmentId: "legacy-department:1",
  semesterId: "legacy-semester:1",
  otherDepartmentId: "legacy-department:2",
};

/** Invented rows only. The source remains immutable during each acceptance phase. */
export const candidateFixtureSql = async (): Promise<string> => {
  const users: string[] = [];

  for (const [index, person] of Object.values(candidateIdentities).entries()) {
    const hash = await runLocal([
      "php",
      "-r",
      "echo password_hash($argv[1], PASSWORD_BCRYPT, ['cost' => 12]);",
      person.password,
    ]);

    assert.match(hash, /^\$2y\$12\$[./A-Za-z0-9]{53}$/);
    users.push(
      `(${index + 1},1,'${person.firstName}','${person.lastName}','${person.email}','12345678',NULL,NULL,'${hash}','${candidateAccount}')`,
    );
  }

  return `
CREATE DATABASE vektor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE vektor;
CREATE TABLE user (
 id INT PRIMARY KEY,is_active TINYINT NOT NULL,firstName VARCHAR(255),lastName VARCHAR(255),
 email VARCHAR(255),phone VARCHAR(255),user_name VARCHAR(255),companyEmail VARCHAR(255),
 password VARCHAR(255),accountNumber VARCHAR(45)
) ENGINE=InnoDB;
CREATE TABLE department (
 id INT PRIMARY KEY,name VARCHAR(255) NOT NULL,short_name VARCHAR(255) NOT NULL,
 email VARCHAR(255) NOT NULL,address VARCHAR(255),city VARCHAR(255) NOT NULL,
 latitude VARCHAR(255),longitude VARCHAR(255),slackChannel VARCHAR(255),logo_path VARCHAR(255),active TINYINT NOT NULL
) ENGINE=InnoDB;
CREATE TABLE semester(id INT PRIMARY KEY,semesterTime VARCHAR(255) NOT NULL,year VARCHAR(4) NOT NULL) ENGINE=InnoDB;
CREATE TABLE school(id INT PRIMARY KEY,name VARCHAR(255) NOT NULL,contactPerson VARCHAR(255) NOT NULL,
 email VARCHAR(255) NOT NULL,phone VARCHAR(255) NOT NULL,international TINYINT NOT NULL,active TINYINT NOT NULL) ENGINE=InnoDB;
CREATE TABLE department_school(department_id INT NOT NULL,school_id INT NOT NULL,PRIMARY KEY(department_id,school_id)) ENGINE=InnoDB;
CREATE TABLE assistant_history(id INT PRIMARY KEY,user_id INT,department_id INT,semester_id INT,school_id INT,
 workdays VARCHAR(255),bolk VARCHAR(255),day VARCHAR(255)) ENGINE=InnoDB;
CREATE TABLE team(id INT PRIMARY KEY,department_id INT,name VARCHAR(255),active TINYINT) ENGINE=InnoDB;
CREATE TABLE position (id INT PRIMARY KEY,name VARCHAR(255)) ENGINE=InnoDB;
CREATE TABLE team_membership(id INT PRIMARY KEY,user_id INT,team_id INT,position_id INT,startSemester_id INT,endSemester_id INT,
 isTeamLeader TINYINT,isSuspended TINYINT,deletedTeamName VARCHAR(255)) ENGINE=InnoDB;
CREATE TABLE executive_board(id INT PRIMARY KEY,name VARCHAR(255)) ENGINE=InnoDB;
CREATE TABLE executive_board_membership(id INT PRIMARY KEY,user_id INT,board_id INT,positionName VARCHAR(255),startSemester_id INT,endSemester_id INT) ENGINE=InnoDB;
CREATE TABLE receipt(id INT PRIMARY KEY,user_id INT,visual_id VARCHAR(255),\`sum\` DOUBLE NOT NULL,
 description VARCHAR(5000) NOT NULL,receiptDate DATETIME NOT NULL,submitDate DATETIME,
 status VARCHAR(255) NOT NULL,refundDate DATETIME,picture_path VARCHAR(255)) ENGINE=InnoDB;
INSERT INTO user VALUES ${users.join(",\n")},
 (5,0,'ExcludedGiven','ExcludedFamily','candidate5@example.invalid','12345678',NULL,NULL,NULL,'${candidateAccount}');
INSERT INTO department VALUES
 (1,'Candidate department','ONE','one@example.invalid',NULL,'Synthetic city',NULL,NULL,NULL,NULL,1),
 (2,'Other candidate department','TWO','two@example.invalid',NULL,'Synthetic city',NULL,NULL,NULL,NULL,1);
INSERT INTO semester VALUES(1,'Høst','2026'),(2,'Vår','2026');
INSERT INTO school VALUES(1,'Candidate school','Synthetic contact','school@example.invalid','12345678',0,1);
INSERT INTO department_school VALUES(1,1);
INSERT INTO assistant_history VALUES
 (101,2,1,1,1,'8','Bolk 1','Mandag'),
 (102,5,1,1,1,'8','Bolk 1','Mandag'),
 (301,3,1,2,1,'8','Bolk 1','Mandag'),
 (302,NULL,1,2,1,'8','Bolk 1','Mandag');
INSERT INTO team VALUES(1,1,'Candidate team',1),(2,2,'Other candidate team',1);
INSERT INTO position VALUES(1,'Leder'),(2,'Medlem');
INSERT INTO team_membership VALUES
 (101,1,1,1,1,NULL,1,0,NULL),
 (102,2,1,2,1,NULL,0,0,NULL),
 (103,3,1,1,2,2,1,0,NULL),
 (104,4,2,1,1,NULL,1,0,NULL),
 (105,5,1,2,1,NULL,0,0,NULL),
 (106,NULL,1,2,1,NULL,0,0,NULL);
INSERT INTO executive_board VALUES(1,'Historical candidate board');
INSERT INTO executive_board_membership VALUES(201,3,1,'Board member',2,2);
INSERT INTO receipt VALUES
 (1,2,'CANDIDATE-1',12.34,'Synthetic candidate pending receipt','2026-08-20 00:00:00','2026-08-21 12:00:00','pending',NULL,'receipt-1.pdf'),
 (2,2,'CANDIDATE-2',23.45,'Synthetic candidate refunded receipt','2026-08-20 00:00:00','2026-08-21 12:00:00','refunded','2026-09-01 12:00:00','receipt-2.pdf'),
 (3,2,'CANDIDATE-3',34.56,'Synthetic excluded receipt','2026-08-20 00:00:00','2026-08-21 12:00:00','rejected',NULL,'receipt-3.pdf'),
 (4,5,'CANDIDATE-4',45.67,'Synthetic quarantined owner receipt','2026-08-20 00:00:00','2026-08-21 12:00:00','pending',NULL,'receipt-4.pdf');
CREATE USER 'legacy_organization_reader'@'localhost';
GRANT SELECT ON vektor.* TO 'legacy_organization_reader'@'localhost';
`;
};
