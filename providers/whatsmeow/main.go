package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/skip2/go-qrcode"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

var client *whatsmeow.Client
var log waLog.Logger
var qrCodeStr string
var qrCodeMutex sync.RWMutex

type webhookPayload struct {
	Event string      `json:"event"`
	Data  interface{} `json:"data"`
}

func eventHandler(evt interface{}) {
	webhookURL := os.Getenv("WEBHOOK_URL")
	if webhookURL == "" {
		return // No webhook configured
	}

	var payload webhookPayload
	switch v := evt.(type) {
	case *events.Message:
		log.Infof("Received message from %s: %s", v.Info.Sender, v.Message.GetConversation())
		payload = webhookPayload{Event: "message", Data: v}
	case *events.Connected:
		log.Infof("Connected to WhatsApp")
		payload = webhookPayload{Event: "connected", Data: nil}
	case *events.Disconnected:
		log.Infof("Disconnected from WhatsApp")
		payload = webhookPayload{Event: "disconnected", Data: nil}
	default:
		return // Ignore other events for now
	}

	go sendWebhook(webhookURL, payload)
}

func sendWebhook(url string, payload webhookPayload) {
	data, err := json.Marshal(payload)
	if err != nil {
		log.Errorf("Failed to marshal webhook payload: %v", err)
		return
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(data))
	if err != nil {
		log.Errorf("Failed to create webhook request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	httpClient := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		log.Errorf("Failed to send webhook: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 {
		log.Warnf("Webhook call failed with status: %s", resp.Status)
	}
}

func getQR(w http.ResponseWriter, r *http.Request) {
	qrCodeMutex.RLock()
	defer qrCodeMutex.RUnlock()
	if qrCodeStr == "" {
		http.Error(w, "QR code not available", http.StatusNotFound)
		return
	}
	// For simplicity, returning the string. The gateway could convert this to an image.
	w.Header().Set("Content-Type", "text/plain")
	fmt.Fprint(w, qrCodeStr)
}

type sendMessageRequest struct {
	To   string `json:"to"`
	Text string `json:"text"`
}

func parseJID(arg string) (types.JID, bool) {
	if arg[0] == '+' {
		arg = arg[1:]
	}
	if !strings.ContainsRune(arg, '@') {
		return types.NewJID(arg, types.DefaultUserServer), true
	}
	recipient, err := types.ParseJID(arg)
	if err != nil {
		log.Errorf("Invalid JID %s: %v", arg, err)
		return recipient, false
	} else if recipient.User == "" {
		log.Errorf("Invalid JID %s: no user specified", arg)
		return recipient, false
	}
	return recipient, true
}

func sendText(w http.ResponseWriter, r *http.Request) {
	if client == nil || !client.IsConnected() {
		http.Error(w, "Client not connected", http.StatusServiceUnavailable)
		return
	}

	var reqBody sendMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&reqBody); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	recipient, ok := parseJID(reqBody.To)
	if !ok {
		http.Error(w, fmt.Sprintf("Invalid JID: %s", reqBody.To), http.StatusBadRequest)
		return
	}

	msg := &types.Message{
		Conversation: proto.String(reqBody.Text),
	}

	ts, err := client.SendMessage(context.Background(), recipient, msg)
	if err != nil {
		log.Errorf("Error sending message: %v", err)
		http.Error(w, "Failed to send message", http.StatusInternalServerError)
		return
	}

	log.Infof("Message sent to %s (ID: %s, Timestamp: %s)", recipient.String(), ts.ID, ts.Timestamp)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok", "id": ts.ID})
}

func startAPIServer() {
	http.HandleFunc("/qr", getQR)
	http.HandleFunc("/send", sendText)
	log.Infof("Starting internal API server on :8080")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Fatalf("API server failed: %v", err)
	}
}

func main() {
	log = waLog.Stdout("main", "INFO", true)
	dbLog := waLog.Stdout("Database", "INFO", true)

	container, err := sqlstore.New("sqlite3", "file:/session/whatsmeow.db?_foreign_keys=on", dbLog)
	if err != nil {
		panic(err)
	}
	deviceStore, err := container.GetFirstDevice()
	if err != nil {
		panic(err)
	}

	client = whatsmeow.NewClient(deviceStore, log)
	client.AddEventHandler(eventHandler)

	go startAPIServer()

	if client.Store.ID == nil {
		qrChan, _ := client.GetQRChannel(context.Background())
		err = client.Connect()
		if err != nil {
			panic(err)
		}
		for evt := range qrChan {
			if evt.Event == "code" {
				qrCodeMutex.Lock()
				qrCodeStr = evt.Code
				qrCodeMutex.Unlock()
				// Also print to console for debugging
				qr, _ := qrcode.New(evt.Code, qrcode.Medium)
				fmt.Println("QR code:\n" + qr.ToString(true))
			} else {
				log.Infof("Login event: %s", evt.Event)
				if evt.Event == "success" {
					qrCodeMutex.Lock()
					qrCodeStr = "" // Clear QR code after login
					qrCodeMutex.Unlock()
				}
			}
		}
	} else {
		err = client.Connect()
		if err != nil {
			panic(err)
		}
	}

	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	<-c

	client.Disconnect()
}