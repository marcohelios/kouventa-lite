package main

import (
	"bytes"
	"bufio"
	"fmt"
	"encoding/json"
	"net/http"
	"log"
	"os"

	"storefront-go/database"
	"storefront-go/models"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/google/uuid"
	"github.com/pgvector/pgvector-go"
	"gorm.io/gorm"
)

// Struct to catch the response from Ollama
type OllamaResponse struct {
	Embedding []float32 `json:"embedding"`
}

type ChatRequest struct {
	Message string `json:"message"`
}
// 2. Structs for Ollama's Chat API
type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type OllamaChatPayload struct {
	Model    string        `json:"model"`
	Messages []ChatMessage `json:"messages"`
	Stream   bool          `json:"stream"`
}

type OllamaStreamResponse struct {
	Message ChatMessage `json:"message"`
	Done    bool        `json:"done"`
}

type SearchRequest struct {
	Query string `json:"query"`
}

func main() {
	database.ConnectDB()
	ollamaURL:= os.Getenv("OLLAMA_URL")
	if ollamaURL == "" {
		ollamaURL = "http://localhost:11434"
	}
	app := fiber.New()
	app.Use(cors.New())

	// ==========================================
	// GET: Fetch all products
	// ==========================================
	app.Get("/api/products", func(c *fiber.Ctx) error {
		var products []models.Product
		
		result := database.DB.Select("id", "name", "description", "price", "category").Order("name ASC").Find(&products)
		if result.Error != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Failed to fetch products"})
		}

		return c.JSON(products)
	})

	// ==========================================
	// POST: Semantic Vector Search
	// ==========================================
	app.Post("/api/search", func(c *fiber.Ctx) error {
		var req SearchRequest

		if err := c.BodyParser(&req); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid request payload"})
		}

		// 1. Embed the user's search query using Ollama
		ollamaReqBody, _ := json.Marshal(map[string]string{
			"model":  "nomic-embed-text",
			"prompt": req.Query,
		})

		resp, err := http.Post(ollamaURL+"/api/embeddings", "application/json", bytes.NewBuffer(ollamaReqBody))
		if err != nil || resp.StatusCode != 200 {
			return c.Status(500).JSON(fiber.Map{"error": "Failed to connect to Ollama"})
		}
		defer resp.Body.Close()

		var ollamaResp OllamaResponse
		if err := json.NewDecoder(resp.Body).Decode(&ollamaResp); err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Failed to parse Ollama response"})
		}

		// 2. Convert to pgvector format
		queryVector := pgvector.NewVector(ollamaResp.Embedding)

		// 3. Search PostgreSQL via GORM
		var products []models.Product
		
		// Use the <=> operator for Cosine Distance. Order by closest match, limit to top 3.
		result := database.DB.Select("id", "name", "description", "price", "category").
			Order(gorm.Expr("embedding <=> ?", queryVector)).
			Find(&products)

		if result.Error != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Failed to query vector database"})
		}

		return c.JSON(fiber.Map{
			"success": true,
			"results": products,
		})
	})

	// ==========================================
	// POST: Add product and generate vector

	app.Post("/api/products", func(c *fiber.Ctx) error {
    var req models.ProductRequest

    log.Println("Incoming Raw JSON:", string(c.Body()))

    // 1. Parse incoming JSON FIRST
    if err := c.BodyParser(&req); err != nil {
        log.Println("BodyParser Error:", err)
        return c.Status(400).JSON(fiber.Map{
            "error":   "Invalid request payload",
            "details": err.Error(),
        })
    }

    log.Printf("Parsed Product: %+v\n", req)

    // 2. NOW build the embedding text, with real values
    embedText := fmt.Sprintf("Product: %s | Category: %s | Details: %s", req.Name, req.Category, req.Description)

    ollamaReqBody, _ := json.Marshal(map[string]string{
        "model":  "nomic-embed-text",
        "prompt": embedText,
    })

    resp, err := http.Post(ollamaURL+"/api/embeddings", "application/json", bytes.NewBuffer(ollamaReqBody))
    if err != nil || resp.StatusCode != 200 {
        log.Println("Ollama Error:", err)
        return c.Status(500).JSON(fiber.Map{"error": "Failed to connect to Ollama"})
    }
    defer resp.Body.Close()

    var ollamaResp OllamaResponse
    if err := json.NewDecoder(resp.Body).Decode(&ollamaResp); err != nil {
        return c.Status(500).JSON(fiber.Map{"error": "Failed to parse Ollama response"})
    }

    newProduct := models.Product{
        ID:          uuid.New().String(),
        Name:        req.Name,
        Description: req.Description,
        Price:       req.Price,
        Category:    req.Category,
        Embedding:   pgvector.NewVector(ollamaResp.Embedding),
    }

    if err := database.DB.Create(&newProduct).Error; err != nil {
        log.Println("DB Save Error:", err)
        return c.Status(500).JSON(fiber.Map{"error": "Failed to save product to database"})
    }

    return c.JSON(fiber.Map{
        "success": true,
        "message": "Successfully processed and saved " + newProduct.Name,
    })
})

	// ==========================================
	// POST: RAG Chat Streaming Endpoint
	// ==========================================
	app.Post("/api/chat", func(c *fiber.Ctx) error {
		var req ChatRequest
		if err := c.BodyParser(&req); err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Invalid request payload"})
		}

		// 1. Embed the user's question
		ollamaEmbedReq, _ := json.Marshal(map[string]string{
			"model":  "nomic-embed-text",
			"prompt": req.Message,
		})

		embedResp, err := http.Post(ollamaURL+"/api/embeddings", "application/json", bytes.NewBuffer(ollamaEmbedReq))
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Failed to connect to Ollama embeddings"})
		}
		defer embedResp.Body.Close()

		var embedData OllamaResponse
		json.NewDecoder(embedResp.Body).Decode(&embedData)
		queryVector := pgvector.NewVector(embedData.Embedding)

		// 2. Retrieve top 3 relevant products from PostgreSQL
		var products []models.Product
		database.DB.Select("name", "description", "price").
			Order(gorm.Expr("embedding <=> ?", queryVector)).
			Find(&products)

		// 3. Build the Context String
		contextString := ""
		for i, p := range products {
			contextString += fmt.Sprintf("[Product %d]: %s\nPrice: $%.2f\nDescription: %s\n\n", i+1, p.Name, p.Price, p.Description)
		}

		systemPrompt := fmt.Sprintf(`You are a helpful e-commerce assistant. Answer the user's question based strictly on the provided product context. 
If the information is not in the context, state that you do not have that information. Do not hallucinate.

Context:
%s`, contextString)

		// 4. Prepare the Llama 3.1 payload
		chatPayload := OllamaChatPayload{
			Model: "llama3.1:8b",
			Stream: true,
			Messages: []ChatMessage{
				{Role: "system", Content: systemPrompt},
				{Role: "user", Content: req.Message},
			},
		}
		chatBody, _ := json.Marshal(chatPayload)

		// 5. Connect to Ollama Chat API
		chatResp, err := http.Post(ollamaURL+"/api/chat", "application/json", bytes.NewBuffer(chatBody))
		if err != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Failed to start chat inference"})
		}

		// 6. Setup Fiber Server-Sent Events (SSE) Headers
		c.Set("Content-Type", "text/event-stream")
		c.Set("Cache-Control", "no-cache")
		c.Set("Connection", "keep-alive")
		c.Set("Transfer-Encoding", "chunked")

		// 7. Stream the response chunks in real-time
		c.Context().SetBodyStreamWriter(func(w *bufio.Writer) {
			defer chatResp.Body.Close()
			scanner := bufio.NewScanner(chatResp.Body)

			for scanner.Scan() {
				var chunk OllamaStreamResponse
				if err := json.Unmarshal(scanner.Bytes(), &chunk); err == nil {
					
					// Format chunk for the frontend exactly like Express did
					if !chunk.Done {
						frontendMsg := map[string]string{
							"type":    "chunk",
							"content": chunk.Message.Content,
						}
						jsonMsg, _ := json.Marshal(frontendMsg)
						fmt.Fprintf(w, "data: %s\n\n", jsonMsg)
					} else {
						fmt.Fprintf(w, "data: {\"type\": \"done\"}\n\n")
					}
					
					// Flush pushes the chunk to the client immediately
					w.Flush() 
				}
			}
		})

		return nil
	})

	// ==========================================
	// DELETE: Remove a product by ID
	// ==========================================
	app.Delete("/api/products/:id", func(c *fiber.Ctx) error {
		productId := c.Params("id")

		// Tell GORM to delete the Product where ID matches the URL parameter
		result := database.DB.Delete(&models.Product{}, "id = ?", productId)

		if result.Error != nil {
			return c.Status(500).JSON(fiber.Map{"error": "Failed to delete product"})
		}

		if result.RowsAffected == 0 {
			return c.Status(404).JSON(fiber.Map{"error": "Product not found"})
		}

		return c.JSON(fiber.Map{
			"success": true,
			"message": "Deleted product ID: " + productId,
		})
	})

	app.Listen(":3001")
}