package models

import (
	"github.com/pgvector/pgvector-go"
	"time"
)

type Product struct {
	ID          string          `gorm:"type:uuid;default:gen_random_uuid();primaryKey" json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Price       float64         `json:"price"`
	Category    string          `json:"category"`
	Embedding   pgvector.Vector `gorm:"type:vector(768)" json:"-"`

	CreatedAt   time.Time       `gorm:"column:createdAt;autoCreateTime" json:"createdAt"`
	UpdatedAt   time.Time       `gorm:"column:updatedAt;autoUpdateTime" json:"updatedAt"`
}

func (Product) TableName() string {
	return "Product"
}

type ProductRequest struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Price       float64 `json:"price"`
	Category    string  `json:"category"`
}

type UserRole string

const (
	RoleNormal  UserRole = "NORMAL"
	RolePremium UserRole = "PREMIUM"
)

type User struct {
	ID           string    `gorm:"column:id;primaryKey"`
	Email        string    `gorm:"column:email;unique"`
	PasswordHash string    `gorm:"column:password_hash"`
	Role         UserRole  `gorm:"column:role"`
	CreatedAt    time.Time `gorm:"column:created_at"`
}

func (User) TableName() string { return "users" }