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