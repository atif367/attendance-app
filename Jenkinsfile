pipeline {
    agent any

    environment {
        DOCKER_IMAGE = 'YOUR_DOCKERHUB_USERNAME/attendance-app'
        DOCKER_TAG = "${env.BUILD_NUMBER}"
        ATTENDANCE_URL = 'http://localhost:8081'
        TEST_CONTAINER = 'attendance-app-test'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Build Test Image') {
            steps {
                sh 'docker build -f dockerfile -t ${DOCKER_IMAGE}:${DOCKER_TAG} .'
                sh 'docker run -d --name ${TEST_CONTAINER} -p 8081:8081 ${DOCKER_IMAGE}:${DOCKER_TAG}'
                sh 'until curl --fail --silent ${ATTENDANCE_URL} > /dev/null; do sleep 2; done'
            }
        }

        stage('Install & Test (Selenium)') {
            steps {
                dir('tests') {
                    sh 'npm ci'
                    sh 'npm test'
                }
            }
        }

        stage('Push Docker Image') {
            steps {
                withCredentials([usernamePassword(
                    credentialsId: 'dockerhub-creds',
                    usernameVariable: 'DOCKER_USER',
                    passwordVariable: 'DOCKER_PASS'
                )]) {
                    sh 'echo "$DOCKER_PASS" | docker login --username "$DOCKER_USER" --password-stdin'
                    sh 'docker push ${DOCKER_IMAGE}:${DOCKER_TAG}'
                    sh 'docker tag ${DOCKER_IMAGE}:${DOCKER_TAG} ${DOCKER_IMAGE}:latest'
                    sh 'docker push ${DOCKER_IMAGE}:latest'
                }
            }
        }

        stage('Deploy to Kubernetes') {
            steps {
                sh 'kubectl apply -f pvc.yaml -f deployment.yaml -f service.yaml'
                sh 'kubectl set image deployment/attendance-app attendance-app=${DOCKER_IMAGE}:${DOCKER_TAG}'
                sh 'kubectl rollout status deployment/attendance-app --timeout=120s'
            }
        }
    }

    post {
        always {
            sh 'docker rm --force ${TEST_CONTAINER} || true'
            sh 'docker logout || true'
            cleanWs()
        }
    }
}
