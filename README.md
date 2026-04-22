<div align="center">
  <h1>🎓 BideshPro</h1>
  <p><b>AI-Powered Study Abroad Consultant for Bangladeshi Students</b></p>
  
  [![Status](https://img.shields.io/badge/Status-Beta-yellow.svg)]()
  [![React](https://img.shields.io/badge/Frontend-React.js-blue.svg)]()
  [![Backend](https://img.shields.io/badge/Backend-Express.js-green.svg)]()
  [![AI](https://img.shields.io/badge/AI-Google_Gemini-orange.svg)]()
</div>

---

## 📖 Overview

**BideshPro** is an intelligent, AI-driven web application designed specifically for Bangladeshi students who are looking to pursue higher education abroad. It utilizes the power of **Google Gemini API** (with real-time Google Search Grounding) to provide accurate, up-to-date, and verified information about international scholarships, living costs, part-time jobs, and university programs.

## ✨ Key Features

- 🌍 **Smart Country Search:** Explore scholarships across 25+ countries tailored to your specific degree level (Bachelor, Master's, PhD) and background (Science, Arts, Commerce).
- 🤖 **Interactive AI Counselor:** Ask custom, open-ended questions about studying abroad and receive comprehensive answers formatted beautifully in Markdown.
- ⚡ **Optimized Performance:** Built-in caching system (`CacheService`) to store recent search results and reduce redundant API calls.
- 🛡️ **Robust Backend & Rate Limiting:** Express.js backend with strict rate limiting, CORS protection, and automatic API key rotation among multiple Gemini models.
- 📲 **Real-time Telegram Monitoring:** Integrated Telegram Bot API to instantly log incoming requests, geolocation data (via `ipapi`), success metrics, and detailed error reports (Timeouts, Quota limits, etc.).
- 🔒 **Anonymous Analytics:** Tracks trending scholarship searches anonymously using Firebase Firestore without requiring user registration.

## 🛠️ Tech Stack

### Frontend
- **Framework:** React.js
- **Styling:** Tailwind CSS (Custom Dark UI)
- **Database/Auth:** Firebase (Anonymous Authentication, Firestore)

### Backend
- **Runtime:** Node.js
- **Framework:** Express.js
- **AI Integration:** Google Gemini API (`gemini-2.5-flash`, `gemini-3-flash-preview`)
- **Deployment Target:** Render / Vercel

---

## 🚀 Getting Started

Follow these steps to run the project locally.

### Prerequisites
- Node.js (v16 or higher)
- npm or yarn
- Firebase Account
- Google Gemini API Keys
- Telegram Bot Token & Chat ID

### 1. Clone the repository
```bash
git clone https://github.com/Rahat0764/StudyAbroadPortal.git
cd StudyAbroadPortal
```

### 2. Frontend Setup
```bash
# Install frontend dependencies
npm install

# Setup Firebase (Add your Firebase config in the environment or directly in App.js)
```

### 3. Backend Setup
Create a `.env` file in the root directory (or wherever your `server.js` is located) and add the following:

```env
PORT=10000
GEMINI_API_KEYS=your_gemini_key_1,your_gemini_key_2
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

```bash
# Run the backend server
node server.js
```

### 4. Run the Application
```bash
# In a new terminal, start the React frontend
npm start
```

---

## 📡 API Endpoint Architecture

### `POST /api/search`
The core endpoint that handles AI requests.
- **Body Request:**
  ```json
  {
    "prompt": "Your constructed AI prompt...",
    "searchQuery": "C_Germany_L_bachelor_B_science_English",
    "locationData": {
      "city": "Dhaka",
      "country": "Bangladesh",
      ...
    }
  }
  ```
- **Failsafe Mechanisms:** - Iterates through multiple provided `GEMINI_API_KEYS`.
  - Falls back to alternate models (e.g., `gemini-2.5-flash-lite`) if the primary model fails or times out.
  - Automatically sends global timeout or server crash reports to the admin's Telegram.

---

## ⚠️ Disclaimer

All scholarship information provided by BideshPro is AI-generated using real-time web searches. While we strive for accuracy, users are strictly advised to **verify all deadlines, requirements, and application portals directly from official university or embassy websites**. BideshPro acts as a research assistant, not an official scholarship provider.

---

## 👨‍💻 Developer

**Rahat Ahmed** - [LinkedIn Profile](https://www.linkedin.com/in/RahatAhmedX)  
- Website: [bidesh.pro.bd](https://bidesh.pro.bd)

<p align="center">
  <i>Developed with ❤️ for Bangladeshi Students</i>
</p>