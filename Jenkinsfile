// Works with Jenkins on Windows (bat) and on Linux / WSL / Docker (sh)
def run(String cmd) {
    if (isUnix()) { sh cmd } else { bat cmd }
}

pipeline {
    agent any

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build Docker Image') {
            steps {
                script {
                    run 'docker build -f dockerfile -t attendance-app:latest .'
                }
            }
        }

        stage('Run Container') {
            steps {
                script {
                    run 'docker rm -f attendance-app || echo no old container'
                    run 'docker run -d --name attendance-app -p 8081:8081 attendance-app:latest'
                    retry(10) {
                        sleep 3
                        run 'curl --fail --silent http://localhost:8081/healthz'
                    }
                }
            }
        }

        stage('Deploy to Kubernetes') {
            steps {
                script {
                    run 'kubectl apply -f pvc.yaml -f deployment.yaml -f service.yaml'
                    run 'kubectl rollout restart deployment/attendance-app'
                    run 'kubectl rollout status deployment/attendance-app --timeout=120s'
                }
            }
        }
    }

    post {
        failure {
            script {
                run 'docker logs attendance-app || echo no container logs'
            }
        }
    }
}